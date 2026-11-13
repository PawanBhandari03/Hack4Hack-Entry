/**
 * All team-formation business rules live here.
 *
 * THE CORE IDEA (how races are prevented)
 * ---------------------------------------
 * Every state change runs inside a MongoDB transaction (runTxn) and uses CONDITIONAL updates:
 *
 *   take a seat      -> Team.findOneAndUpdate({ _id, openSeats: { $gt: 0 } }, { $inc: { openSeats: -1, memberCount: 1 } })
 *   claim the person -> Participant.findOneAndUpdate({ hackathonId, userId, teamId: null }, { $set: { teamId } })
 *
 * A single-document update in MongoDB is atomic, and when two transactions write the SAME document
 * at the same time MongoDB aborts one with a WriteConflict. withTransaction() retries the loser,
 * which then re-reads fresh data and sees openSeats === 0 (TEAM_FULL) or teamId !== null (ALREADY_IN_TEAM).
 * So when 50 people race for the last seat, exactly one transaction can commit the seat.
 *
 * Because both updates are in one transaction, we can never end up "person claimed but no seat"
 * or "seat taken but person not claimed" — it's all or nothing.
 */
import mongoose from 'mongoose';
import { Team, Participant, Invite, JoinRequest, AuditLog, Hackathon, User } from '../models/index.js';
import { runTxn } from '../lib/txn.js';
import { rooms, publish } from '../lib/realtime.js';
import { badRequest, conflict, forbidden, gone, notFound, isDuplicateKey } from '../lib/errors.js';
import { generateInviteCode, hashInviteCode } from '../lib/inviteCode.js';
import { config } from '../config.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const same = (a, b) => a != null && b != null && String(a) === String(b);

/* ----------------------------- serialisers ----------------------------- */

export const teamSummary = (t) => ({
  id: String(t._id),
  hackathonId: String(t.hackathonId),
  name: t.name,
  description: t.description,
  skillsWanted: t.skillsWanted,
  leaderId: String(t.leaderId),
  memberCount: t.memberCount,
  openSeats: t.openSeats,
  minSize: t.minSize,
  maxSize: t.maxSize,
  meetsMinimum: t.memberCount >= t.minSize,
  lookingForMembers: t.lookingForMembers,
  updatedAt: t.updatedAt,
});

export const personSummary = (p) => ({
  userId: String(p.userId),
  name: p.name,
  skills: p.skills,
  timezone: p.timezone,
  bio: p.bio,
  teamId: p.teamId ? String(p.teamId) : null,
  role: p.role,
  lookingForTeam: p.lookingForTeam,
  joinedTeamAt: p.joinedTeamAt,
  updatedAt: p.updatedAt,
});

export const requestSummary = (r) => ({
  id: String(r._id),
  teamId: String(r.teamId),
  teamName: r.teamName,
  userId: String(r.userId),
  userName: r.userName,
  userSkills: r.userSkills,
  message: r.message,
  status: r.status,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
});

/* ------------------------------- helpers ------------------------------- */

async function audit(session, entry) {
  await AuditLog.create([entry], { session });
}

/** Board + team-page events after any change to a team. */
function teamChangedEvents(events, team) {
  const summary = teamSummary(team);
  events.push({ room: rooms.hackathon(team.hackathonId), event: 'board:team', payload: summary });
  events.push({ room: rooms.team(team._id), event: 'team:updated', payload: { teamId: summary.id } });
}

function teamDeletedEvents(events, team) {
  const payload = { teamId: String(team._id) };
  events.push({ room: rooms.hackathon(team.hackathonId), event: 'board:team-removed', payload });
  events.push({ room: rooms.team(team._id), event: 'team:deleted', payload });
}

function personChangedEvents(events, participant) {
  events.push({
    room: rooms.hackathon(participant.hackathonId),
    event: 'board:person',
    payload: personSummary(participant),
  });
  events.push({ room: rooms.user(participant.userId), event: 'me:updated', payload: {} });
}

/** Cancel every pending request of a user in a hackathon (they just joined a team). */
async function cancelPendingRequestsOfUser(session, events, hackathonId, userId) {
  const pending = await JoinRequest.find({ hackathonId, userId, status: 'pending' })
    .select('teamId')
    .session(session)
    .lean();
  if (!pending.length) return;
  await JoinRequest.updateMany(
    { _id: { $in: pending.map((r) => r._id) } },
    { $set: { status: 'cancelled', decidedAt: new Date() } },
    { session }
  );
  for (const r of pending) {
    events.push({ room: rooms.team(r.teamId), event: 'team:requests', payload: { teamId: String(r.teamId) } });
  }
}

export async function getHackathonOrThrow(hackathonId) {
  if (!mongoose.isValidObjectId(hackathonId)) throw notFound('HACKATHON_NOT_FOUND', 'Hackathon not found');
  const h = await Hackathon.findById(hackathonId).lean();
  if (!h) throw notFound('HACKATHON_NOT_FOUND', 'Hackathon not found');
  return h;
}

/**
 * Register a user in a hackathon (idempotent). Upsert + unique index means two parallel
 * calls still produce exactly one Participant row.
 */
export async function ensureParticipant(hackathonId, userId) {
  await getHackathonOrThrow(hackathonId);
  const user = await User.findById(userId).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'User not found');
  const filter = { hackathonId: oid(hackathonId), userId: user._id };
  try {
    return await Participant.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          name: user.name,
          skills: user.skills,
          timezone: user.timezone,
          utcOffsetMinutes: user.utcOffsetMinutes,
          bio: user.bio,
        },
      },
      { upsert: true, returnDocument: 'after' }
    ).lean();
  } catch (err) {
    if (isDuplicateKey(err)) return Participant.findOne(filter).lean(); // lost the upsert race: row exists now
    throw err;
  }
}

/**
 * Add a user to a team. MUST be called inside a transaction.
 * Order matters only for which error we report; atomicity comes from the transaction.
 */
async function addMemberInTxn(session, events, { team, userId, actorId, via }) {
  const now = new Date();
  const participant = await Participant.findOneAndUpdate(
    { hackathonId: team.hackathonId, userId, teamId: null },
    { $set: { teamId: team._id, role: 'member', joinedTeamAt: now, lookingForTeam: false } },
    { returnDocument: 'after', session }
  );
  if (!participant) {
    const registered = await Participant.exists({ hackathonId: team.hackathonId, userId }).session(session);
    if (!registered) throw badRequest('NOT_REGISTERED', 'Register for this hackathon first');
    throw conflict('ALREADY_IN_TEAM', 'You are already in a team for this hackathon');
  }

  // THE race-proof line: only succeeds if a seat is still open at commit time.
  const updated = await Team.findOneAndUpdate(
    { _id: team._id, openSeats: { $gt: 0 } },
    { $inc: { openSeats: -1, memberCount: 1 } },
    { returnDocument: 'after', session }
  );
  if (!updated) {
    const exists = await Team.exists({ _id: team._id }).session(session);
    if (!exists) throw notFound('TEAM_NOT_FOUND', 'This team no longer exists');
    throw conflict('TEAM_FULL', 'This team is already full');
  }

  await cancelPendingRequestsOfUser(session, events, team.hackathonId, userId);
  await audit(session, {
    hackathonId: team.hackathonId,
    teamId: team._id,
    actorId,
    action: 'MEMBER_JOINED',
    targetUserId: userId,
    details: { via, memberCount: updated.memberCount },
  });
  teamChangedEvents(events, updated);
  personChangedEvents(events, participant);
  return { team: updated, participant };
}

/**
 * Remove a user from a team (leave or kick). MUST be called inside a transaction.
 * Handles: leader transfer to the longest-standing member, and deleting the team when empty.
 */
async function removeMemberInTxn(session, events, { teamId, userId, actorId, action }) {
  const participant = await Participant.findOneAndUpdate(
    { userId, teamId },
    { $set: { teamId: null, role: null, joinedTeamAt: null, lookingForTeam: true } },
    { returnDocument: 'after', session }
  );
  if (!participant) throw notFound('NOT_A_MEMBER', 'That user is not in this team');

  const team = await Team.findOneAndUpdate(
    { _id: teamId },
    { $inc: { memberCount: -1, openSeats: 1 } },
    { returnDocument: 'after', session }
  );
  if (!team) throw notFound('TEAM_NOT_FOUND', 'Team not found');

  await audit(session, {
    hackathonId: team.hackathonId,
    teamId: team._id,
    actorId,
    action,
    targetUserId: userId,
    details: { memberCount: team.memberCount },
  });
  personChangedEvents(events, participant);

  // Rule: last member leaves -> team is deleted (and its invites/requests closed).
  if (team.memberCount <= 0) {
    await Team.deleteOne({ _id: team._id }, { session });
    await Invite.updateMany({ teamId: team._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
    const pending = await JoinRequest.find({ teamId: team._id, status: 'pending' }).select('userId').session(session).lean();
    await JoinRequest.updateMany(
      { teamId: team._id, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: new Date() } },
      { session }
    );
    for (const r of pending) {
      events.push({ room: rooms.user(r.userId), event: 'me:updated', payload: {} });
    }
    await audit(session, {
      hackathonId: team.hackathonId,
      teamId: team._id,
      actorId,
      action: 'TEAM_DELETED',
      details: { reason: 'last member left', name: team.name },
    });
    teamDeletedEvents(events, team);
    return { team: null, deleted: true };
  }

  // Rule: leader leaves -> leadership passes to the member who joined earliest.
  if (same(team.leaderId, userId)) {
    const next = await Participant.findOne({ teamId: team._id }).sort({ joinedTeamAt: 1, _id: 1 }).session(session);
    await Participant.updateOne({ _id: next._id }, { $set: { role: 'leader' } }, { session });
    team.leaderId = next.userId;
    await Team.updateOne({ _id: team._id }, { $set: { leaderId: next.userId } }, { session });
    await audit(session, {
      hackathonId: team.hackathonId,
      teamId: team._id,
      actorId,
      action: 'LEADER_TRANSFERRED',
      targetUserId: next.userId,
      details: { reason: 'previous leader left', previousLeaderId: String(userId) },
    });
    events.push({ room: rooms.user(next.userId), event: 'me:updated', payload: {} });
  }

  teamChangedEvents(events, team);
  return { team, deleted: false };
}

async function loadTeamAsLeader(session, teamId, actorId) {
  if (!mongoose.isValidObjectId(teamId)) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  const team = await Team.findById(teamId).session(session);
  if (!team) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  if (!same(team.leaderId, actorId)) throw forbidden('NOT_LEADER', 'Only the team leader can do this');
  return team;
}

/* ------------------------------- commands ------------------------------ */

export async function createTeam(userId, hackathonId, { name, description = '', skillsWanted = [] }) {
  const hackathon = await getHackathonOrThrow(hackathonId);
  await ensureParticipant(hackathonId, userId);
  try {
    return await runTxn(async (session, events) => {
      const teamId = new mongoose.Types.ObjectId();
      const participant = await Participant.findOneAndUpdate(
        { hackathonId: hackathon._id, userId, teamId: null },
        { $set: { teamId, role: 'leader', joinedTeamAt: new Date(), lookingForTeam: false } },
        { returnDocument: 'after', session }
      );
      if (!participant) throw conflict('ALREADY_IN_TEAM', 'You are already in a team for this hackathon');

      const [team] = await Team.create(
        [
          {
            _id: teamId,
            hackathonId: hackathon._id,
            name,
            nameKey: name.trim().toLowerCase(),
            description,
            skillsWanted,
            leaderId: userId,
            memberCount: 1,
            openSeats: hackathon.maxTeamSize - 1,
            minSize: hackathon.minTeamSize,
            maxSize: hackathon.maxTeamSize,
            lookingForMembers: hackathon.maxTeamSize > 1,
          },
        ],
        { session }
      );
      await cancelPendingRequestsOfUser(session, events, hackathon._id, userId);
      await audit(session, {
        hackathonId: hackathon._id,
        teamId,
        actorId: userId,
        action: 'TEAM_CREATED',
        details: { name },
      });
      teamChangedEvents(events, team);
      personChangedEvents(events, participant);
      return teamSummary(team);
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('TEAM_NAME_TAKEN', 'A team with this name already exists');
    throw err;
  }
}

export async function updateTeam(actorId, teamId, patch) {
  try {
    return await runTxn(async (session, events) => {
      const team = await loadTeamAsLeader(session, teamId, actorId);
      if (patch.name !== undefined) {
        team.name = patch.name;
        team.nameKey = patch.name.trim().toLowerCase();
      }
      if (patch.description !== undefined) team.description = patch.description;
      if (patch.skillsWanted !== undefined) team.skillsWanted = patch.skillsWanted;
      if (patch.lookingForMembers !== undefined) team.lookingForMembers = patch.lookingForMembers;
      await team.save({ session });
      await audit(session, {
        hackathonId: team.hackathonId,
        teamId: team._id,
        actorId,
        action: 'TEAM_UPDATED',
        details: { fields: Object.keys(patch) },
      });
      teamChangedEvents(events, team);
      return teamSummary(team);
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('TEAM_NAME_TAKEN', 'A team with this name already exists');
    throw err;
  }
}

export async function leaveTeam(userId, teamId) {
  if (!mongoose.isValidObjectId(teamId)) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  return runTxn(async (session, events) => {
    const result = await removeMemberInTxn(session, events, {
      teamId: oid(teamId),
      userId,
      actorId: userId,
      action: 'MEMBER_LEFT',
    });
    return { deleted: result.deleted, team: result.team ? teamSummary(result.team) : null };
  });
}

export async function removeMember(actorId, teamId, targetUserId) {
  if (same(actorId, targetUserId)) throw badRequest('USE_LEAVE', 'Use "leave team" to remove yourself');
  if (!mongoose.isValidObjectId(targetUserId)) throw notFound('NOT_A_MEMBER', 'That user is not in this team');
  return runTxn(async (session, events) => {
    const team = await loadTeamAsLeader(session, teamId, actorId);
    const result = await removeMemberInTxn(session, events, {
      teamId: team._id,
      userId: oid(targetUserId),
      actorId,
      action: 'MEMBER_REMOVED',
    });
    return { team: result.team ? teamSummary(result.team) : null };
  });
}

export async function transferLeadership(actorId, teamId, newLeaderId) {
  if (!mongoose.isValidObjectId(newLeaderId)) throw notFound('NOT_A_MEMBER', 'That user is not in this team');
  return runTxn(async (session, events) => {
    const team = await loadTeamAsLeader(session, teamId, actorId);
    if (same(newLeaderId, actorId)) throw badRequest('ALREADY_LEADER', 'You are already the leader');
    const target = await Participant.findOneAndUpdate(
      { teamId: team._id, userId: oid(newLeaderId) },
      { $set: { role: 'leader' } },
      { returnDocument: 'after', session }
    );
    if (!target) throw notFound('NOT_A_MEMBER', 'That user is not in this team');
    await Participant.updateOne({ teamId: team._id, userId: actorId }, { $set: { role: 'member' } }, { session });
    team.leaderId = target.userId;
    await team.save({ session });
    await audit(session, {
      hackathonId: team.hackathonId,
      teamId: team._id,
      actorId,
      action: 'LEADER_TRANSFERRED',
      targetUserId: target.userId,
      details: { reason: 'manual transfer' },
    });
    teamChangedEvents(events, team);
    events.push({ room: rooms.user(target.userId), event: 'me:updated', payload: {} });
    return teamSummary(team);
  });
}

/* ------------------------------ invite codes ----------------------------- */

/** Leader generates a fresh code; all previous codes for the team are revoked. */
export async function createInvite(actorId, teamId) {
  return runTxn(async (session) => {
    const team = await loadTeamAsLeader(session, teamId, actorId);
    const now = new Date();
    await Invite.updateMany({ teamId: team._id, revokedAt: null }, { $set: { revokedAt: now } }, { session });
    const code = generateInviteCode();
    const expiresAt = new Date(now.getTime() + config.inviteCodeTtlHours * 3600 * 1000);
    await Invite.create(
      [{ hackathonId: team.hackathonId, teamId: team._id, codeHash: hashInviteCode(code), createdBy: actorId, expiresAt }],
      { session }
    );
    await audit(session, {
      hackathonId: team.hackathonId,
      teamId: team._id,
      actorId,
      action: 'INVITE_CREATED',
      details: { expiresAt },
    });
    return { code, expiresAt };
  });
}

export async function revokeInvites(actorId, teamId) {
  return runTxn(async (session) => {
    const team = await loadTeamAsLeader(session, teamId, actorId);
    const res = await Invite.updateMany({ teamId: team._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
    await audit(session, { hackathonId: team.hackathonId, teamId: team._id, actorId, action: 'INVITES_REVOKED' });
    return { revoked: res.modifiedCount };
  });
}

/** Join directly with an invite code (the code is the leader's pre-approval). */
export async function redeemInvite(userId, code) {
  const invite = await Invite.findOne({ codeHash: hashInviteCode(code) }).lean();
  // Same response for "never existed" and "revoked" so attackers learn nothing.
  if (!invite || invite.revokedAt) throw notFound('INVALID_INVITE', 'Invalid invite code');
  if (invite.expiresAt <= new Date()) throw gone('INVITE_EXPIRED', 'This invite code has expired');

  await ensureParticipant(invite.hackathonId, userId);
  return runTxn(async (session, events) => {
    // Re-check validity INSIDE the transaction and touch the invite doc, so a concurrent
    // revoke/regenerate (which also writes this doc) causes a write conflict instead of a stale join.
    const live = await Invite.findOneAndUpdate(
      { _id: invite._id, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $inc: { uses: 1 } },
      { returnDocument: 'after', session }
    );
    if (!live) throw notFound('INVALID_INVITE', 'Invalid invite code');
    const team = await Team.findById(invite.teamId).session(session);
    if (!team) throw notFound('TEAM_NOT_FOUND', 'This team no longer exists');
    const { team: updated } = await addMemberInTxn(session, events, { team, userId, actorId: userId, via: 'invite' });
    return teamSummary(updated);
  });
}

/* ------------------------------ join requests ---------------------------- */

export async function requestToJoin(userId, teamId, message = '') {
  if (!mongoose.isValidObjectId(teamId)) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  const team = await Team.findById(teamId).lean();
  if (!team) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  const participant = await ensureParticipant(team.hackathonId, userId);
  if (participant.teamId) throw conflict('ALREADY_IN_TEAM', 'You are already in a team for this hackathon');
  if (team.openSeats <= 0) throw conflict('TEAM_FULL', 'This team is already full');
  if (!team.lookingForMembers) throw conflict('TEAM_NOT_RECRUITING', 'This team is not accepting requests');

  try {
    return await runTxn(async (session, events) => {
      const [req] = await JoinRequest.create(
        [
          {
            hackathonId: team.hackathonId,
            teamId: team._id,
            userId,
            userName: participant.name,
            userSkills: participant.skills,
            teamName: team.name,
            message,
          },
        ],
        { session }
      );
      await audit(session, {
        hackathonId: team.hackathonId,
        teamId: team._id,
        actorId: userId,
        action: 'JOIN_REQUESTED',
        targetUserId: userId,
      });
      events.push({ room: rooms.team(team._id), event: 'team:requests', payload: { teamId: String(team._id) } });
      events.push({ room: rooms.user(team.leaderId), event: 'notify', payload: { type: 'join_request', teamId: String(team._id), from: participant.name } });
      return { request: requestSummary(req), created: true };
    });
  } catch (err) {
    // Partial unique index: a pending request already exists -> return it (idempotent).
    if (isDuplicateKey(err)) {
      const existing = await JoinRequest.findOne({ teamId: team._id, userId, status: 'pending' }).lean();
      if (existing) return { request: requestSummary(existing), created: false };
    }
    throw err;
  }
}

export async function decideRequest(actorId, requestId, decision) {
  if (!mongoose.isValidObjectId(requestId)) throw notFound('REQUEST_NOT_FOUND', 'Request not found');
  return runTxn(async (session, events) => {
    const req = await JoinRequest.findById(requestId).session(session);
    if (!req) throw notFound('REQUEST_NOT_FOUND', 'Request not found');
    const team = await loadTeamAsLeader(session, req.teamId, actorId);
    const status = decision === 'accept' ? 'accepted' : 'declined';
    // Conditional on still being pending: two leaders' tabs clicking at once -> only one decides.
    const decided = await JoinRequest.findOneAndUpdate(
      { _id: req._id, status: 'pending' },
      { $set: { status, decidedBy: actorId, decidedAt: new Date() } },
      { returnDocument: 'after', session }
    );
    if (!decided) throw conflict('ALREADY_DECIDED', `This request is already ${req.status}`);

    if (status === 'accepted') {
      await addMemberInTxn(session, events, { team, userId: req.userId, actorId, via: 'request' });
    }
    await audit(session, {
      hackathonId: team.hackathonId,
      teamId: team._id,
      actorId,
      action: status === 'accepted' ? 'REQUEST_ACCEPTED' : 'REQUEST_DECLINED',
      targetUserId: req.userId,
    });
    events.push({ room: rooms.team(team._id), event: 'team:requests', payload: { teamId: String(team._id) } });
    events.push({ room: rooms.user(req.userId), event: 'notify', payload: { type: `request_${status}`, teamId: String(team._id), teamName: team.name } });
    events.push({ room: rooms.user(req.userId), event: 'me:updated', payload: {} });
    return requestSummary(decided);
  });
}

export async function cancelRequest(userId, requestId) {
  if (!mongoose.isValidObjectId(requestId)) throw notFound('REQUEST_NOT_FOUND', 'Request not found');
  return runTxn(async (session, events) => {
    const req = await JoinRequest.findOneAndUpdate(
      { _id: requestId, userId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: new Date() } },
      { returnDocument: 'after', session }
    );
    if (!req) throw notFound('REQUEST_NOT_FOUND', 'No pending request found');
    await audit(session, {
      hackathonId: req.hackathonId,
      teamId: req.teamId,
      actorId: userId,
      action: 'JOIN_REQUEST_CANCELLED',
      targetUserId: userId,
    });
    events.push({ room: rooms.team(req.teamId), event: 'team:requests', payload: { teamId: String(req.teamId) } });
    return requestSummary(req);
  });
}

/* -------------------------------- queries -------------------------------- */

export async function getTeamDetails(teamId, viewerId) {
  if (!mongoose.isValidObjectId(teamId)) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  const team = await Team.findById(teamId).lean();
  if (!team) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  const members = await Participant.find({ teamId: team._id }).sort({ joinedTeamAt: 1 }).lean();
  const isMember = members.some((m) => same(m.userId, viewerId));
  const isLeader = same(team.leaderId, viewerId);
  const result = { team: teamSummary(team), members: members.map(personSummary), isMember, isLeader };
  if (isLeader) {
    const reqs = await JoinRequest.find({ teamId: team._id, status: 'pending' }).sort({ createdAt: 1 }).lean();
    result.pendingRequests = reqs.map(requestSummary);
  }
  if (!isMember) {
    const mine = await JoinRequest.findOne({ teamId: team._id, userId: viewerId, status: 'pending' }).lean();
    result.myPendingRequest = mine ? requestSummary(mine) : null;
  }
  return result;
}

export async function getTeamAudit(teamId, viewerId, limit = 50) {
  if (!mongoose.isValidObjectId(teamId)) throw notFound('TEAM_NOT_FOUND', 'Team not found');
  const member = await Participant.exists({ teamId, userId: viewerId });
  if (!member) throw forbidden('NOT_A_MEMBER', 'Only team members can view the audit log');
  const logs = await AuditLog.find({ teamId }).sort({ createdAt: -1 }).limit(limit).lean();
  const ids = [...new Set(logs.flatMap((l) => [l.actorId, l.targetUserId]).filter(Boolean).map(String))];
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  const names = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  return logs.map((l) => ({
    id: String(l._id),
    action: l.action,
    actorId: String(l.actorId),
    actorName: names[String(l.actorId)] ?? 'Unknown',
    targetUserId: l.targetUserId ? String(l.targetUserId) : null,
    targetName: l.targetUserId ? names[String(l.targetUserId)] ?? 'Unknown' : null,
    details: l.details,
    at: l.createdAt,
  }));
}

/** Everything the UI needs about "me" in a hackathon in one call. */
export async function getMyState(hackathonId, userId) {
  const hackathon = await getHackathonOrThrow(hackathonId);
  const participant = await ensureParticipant(hackathonId, userId);
  const team = participant.teamId ? await Team.findById(participant.teamId).lean() : null;
  const requests = await JoinRequest.find({ hackathonId: hackathon._id, userId, status: 'pending' })
    .sort({ createdAt: -1 })
    .lean();
  return {
    hackathon: {
      id: String(hackathon._id),
      name: hackathon.name,
      description: hackathon.description,
      minTeamSize: hackathon.minTeamSize,
      maxTeamSize: hackathon.maxTeamSize,
    },
    me: personSummary(participant),
    team: team ? teamSummary(team) : null,
    pendingRequests: requests.map(requestSummary),
  };
}

export async function setLookingForTeam(hackathonId, userId, lookingForTeam) {
  await ensureParticipant(hackathonId, userId);
  const p = await Participant.findOneAndUpdate(
    { hackathonId: oid(hackathonId), userId },
    { $set: { lookingForTeam } },
    { returnDocument: 'after' }
  ).lean();
  const events = [];
  personChangedEvents(events, p);
  publish(events);
  return personSummary(p);
}
