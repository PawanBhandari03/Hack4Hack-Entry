import { describe, it, expect } from 'vitest';
import { api, makeHackathon, makeUser, makeUsers, createTeamVia, inviteCode, joinWithCode, key } from './helpers.js';
import { Team, Participant, Invite, AuditLog, JoinRequest, Hackathon } from '../src/models/index.js';
import { clearHackathonCache } from '../src/services/teamService.js';

describe('team rules', () => {
  it('creates a team with the creator as leader and enforces unique names', async () => {
    const h = await makeHackathon({ maxTeamSize: 3 });
    const [a, b] = await makeUsers(2);
    const team = await createTeamVia(a, h._id, { name: 'Rocket', skillsWanted: ['React'] });
    expect(team.leaderId).toBe(a.id);
    expect(team.memberCount).toBe(1);
    expect(team.openSeats).toBe(2);
    expect(team.meetsMinimum).toBe(false); // min size 2
    const dup = await api().post(`/api/hackathons/${h._id}/teams`).set(b.auth).send({ name: 'rocket' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TEAM_NAME_TAKEN');
  });

  it('enforces max size: the (max+1)th join is rejected', async () => {
    const h = await makeHackathon({ maxTeamSize: 2 });
    const leader = await makeUser();
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);
    const [m1, m2] = await makeUsers(2);
    const ok = await joinWithCode(m1, code);
    expect(ok.status).toBe(200);
    expect(ok.body.team.meetsMinimum).toBe(true);
    const full = await joinWithCode(m2, code);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('TEAM_FULL');
  });

  it('one team per person: cannot create or join a second team', async () => {
    const h = await makeHackathon();
    const [a, b] = await makeUsers(2);
    await createTeamVia(a, h._id);
    const tB = await createTeamVia(b, h._id);
    const again = await api().post(`/api/hackathons/${h._id}/teams`).set(a.auth).send({ name: 'Second' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_IN_TEAM');
    const join = await joinWithCode(a, await inviteCode(b, tB.id));
    expect(join.status).toBe(409);
    expect(join.body.error.code).toBe('ALREADY_IN_TEAM');
  });

  it('leader leaves -> leadership passes to the earliest-joined member', async () => {
    const h = await makeHackathon();
    const [leader, first, second] = await makeUsers(3);
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);
    await joinWithCode(first, code);
    await joinWithCode(second, code);
    const res = await api().post(`/api/teams/${team.id}/leave`).set(leader.auth);
    expect(res.status).toBe(200);
    expect(res.body.team.leaderId).toBe(first.id);
    const p = await Participant.findOne({ userId: first.id }).lean();
    expect(p.role).toBe('leader');
    expect(await AuditLog.countDocuments({ teamId: team.id, action: 'LEADER_TRANSFERRED' })).toBe(1);
  });

  it('last member leaves -> team is deleted and its invites revoked', async () => {
    const h = await makeHackathon();
    const leader = await makeUser();
    const team = await createTeamVia(leader, h._id);
    await inviteCode(leader, team.id);
    const res = await api().post(`/api/teams/${team.id}/leave`).set(leader.auth);
    expect(res.body.deleted).toBe(true);
    expect(await Team.countDocuments({ _id: team.id })).toBe(0);
    expect(await Invite.countDocuments({ teamId: team.id, revokedAt: null })).toBe(0);
    const p = await Participant.findOne({ userId: leader.id }).lean();
    expect(p.teamId).toBeNull();
    expect(p.lookingForTeam).toBe(true);
  });

  it('only the leader can remove members, accept requests, edit or create invites', async () => {
    const h = await makeHackathon();
    const [leader, member, outsider] = await makeUsers(3);
    const team = await createTeamVia(leader, h._id);
    await joinWithCode(member, await inviteCode(leader, team.id));
    const req = await api().post(`/api/teams/${team.id}/requests`).set(outsider.auth).send({});

    const checks = await Promise.all([
      api().delete(`/api/teams/${team.id}/members/${leader.id}`).set(member.auth),
      api().post(`/api/requests/${req.body.request.id}/accept`).set(member.auth),
      api().patch(`/api/teams/${team.id}`).set(member.auth).send({ name: 'Hijacked' }),
      api().post(`/api/teams/${team.id}/invites`).set(member.auth),
    ]);
    for (const r of checks) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('NOT_LEADER');
    }

    const kick = await api().delete(`/api/teams/${team.id}/members/${member.id}`).set(leader.auth);
    expect(kick.status).toBe(200);
    expect(kick.body.team.memberCount).toBe(1);
  });

  it('leader can transfer leadership manually', async () => {
    const h = await makeHackathon();
    const [leader, member] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    await joinWithCode(member, await inviteCode(leader, team.id));
    const res = await api().post(`/api/teams/${team.id}/leader`).set(leader.auth).send({ userId: member.id });
    expect(res.status).toBe(200);
    expect(res.body.team.leaderId).toBe(member.id);
  });
});

describe('invite codes', () => {
  it('codes are random, hashed at rest, and the old code dies when a new one is generated', async () => {
    const h = await makeHackathon();
    const [leader, u1] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const c1 = await inviteCode(leader, team.id);
    expect(c1).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const stored = await Invite.findOne({ teamId: team.id }).lean();
    expect(stored.codeHash).not.toContain(c1.replace('-', '')); // plaintext never stored
    const c2 = await inviteCode(leader, team.id);
    expect(c2).not.toBe(c1);
    expect((await joinWithCode(u1, c1)).status).toBe(404);
    expect((await joinWithCode(u1, c2.toLowerCase().replace('-', ' '))).status).toBe(200); // forgiving input
  });

  it('expired codes are rejected with 410', async () => {
    const h = await makeHackathon();
    const [leader, u] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);
    await Invite.updateMany({ teamId: team.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await joinWithCode(u, code);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITE_EXPIRED');
  });

  it('brute force is rate limited per user (10 tries / 15 min)', async () => {
    const u = await makeUser();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await joinWithCode(u, `AAAAA-AAA${String(i).padStart(2, '0')}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('join requests', () => {
  it('request -> leader declines -> request again -> leader accepts', async () => {
    const h = await makeHackathon();
    const [leader, u] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const r1 = await api().post(`/api/teams/${team.id}/requests`).set(u.auth).send({ message: 'I do backend' });
    expect(r1.status).toBe(201);
    const details = await api().get(`/api/teams/${team.id}`).set(leader.auth);
    expect(details.body.pendingRequests).toHaveLength(1);

    expect((await api().post(`/api/requests/${r1.body.request.id}/decline`).set(leader.auth)).status).toBe(200);
    const again = await api().post(`/api/requests/${r1.body.request.id}/accept`).set(leader.auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');

    const r2 = await api().post(`/api/teams/${team.id}/requests`).set(u.auth).send({});
    expect(r2.status).toBe(201);
    const acc = await api().post(`/api/requests/${r2.body.request.id}/accept`).set(leader.auth);
    expect(acc.status).toBe(200);
    expect((await Participant.findOne({ userId: u.id }).lean()).teamId.toString()).toBe(team.id);
  });

  it('duplicate requests return the existing one instead of creating another', async () => {
    const h = await makeHackathon();
    const [leader, u] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api().post(`/api/teams/${team.id}/requests`).set(u.auth).send({}))
    );
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(results.map((r) => r.body.request.id)).size).toBe(1);
    expect(await JoinRequest.countDocuments({ teamId: team.id })).toBe(1);
  });

  it('joining a team cancels your other pending requests', async () => {
    const h = await makeHackathon();
    const [l1, l2, u] = await makeUsers(3);
    const t1 = await createTeamVia(l1, h._id);
    const t2 = await createTeamVia(l2, h._id);
    await api().post(`/api/teams/${t1.id}/requests`).set(u.auth).send({});
    await joinWithCode(u, await inviteCode(l2, t2.id));
    expect(await JoinRequest.countDocuments({ userId: u.id, status: 'pending' })).toBe(0);
  });
});

describe('idempotency', () => {
  it('retrying create-team with the same Idempotency-Key replays the first response', async () => {
    const h = await makeHackathon();
    const u = await makeUser();
    const k = key();
    const first = await api().post(`/api/hackathons/${h._id}/teams`).set(u.auth).set('Idempotency-Key', k).send({ name: 'Once' });
    const retry = await api().post(`/api/hackathons/${h._id}/teams`).set(u.auth).set('Idempotency-Key', k).send({ name: 'Once' });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.team.id).toBe(first.body.team.id);
    expect(await Team.countDocuments({})).toBe(1);
  });

  it('a double-click (same key, concurrent) joins only once', async () => {
    const h = await makeHackathon();
    const [leader, u] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);
    const k = key();
    const results = await Promise.all(
      [1, 2, 3].map(() => api().post('/api/invites/redeem').set(u.auth).set('Idempotency-Key', k).send({ code }))
    );
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.status === 200 || r.body.error?.code === 'REQUEST_IN_PROGRESS')).toBe(true);
    expect((await Team.findById(team.id).lean()).memberCount).toBe(2);
  });

  it('the same key cannot be reused for a different endpoint', async () => {
    const h = await makeHackathon();
    const [leader, u] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const k = key();
    await api().post(`/api/teams/${team.id}/requests`).set(u.auth).set('Idempotency-Key', k).send({});
    const res = await api().post(`/api/hackathons/${h._id}/teams`).set(u.auth).set('Idempotency-Key', k).send({ name: 'X1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('audit log', () => {
  it('records who did what and when, visible only to members', async () => {
    const h = await makeHackathon();
    const [leader, member, outsider] = await makeUsers(3);
    const team = await createTeamVia(leader, h._id);
    await joinWithCode(member, await inviteCode(leader, team.id));
    await api().post(`/api/teams/${team.id}/leave`).set(member.auth);

    const res = await api().get(`/api/teams/${team.id}/audit`).set(leader.auth);
    expect(res.status).toBe(200);
    const actions = res.body.items.map((i) => i.action);
    expect(actions).toEqual(['MEMBER_LEFT', 'MEMBER_JOINED', 'INVITE_CREATED', 'TEAM_CREATED']);
    expect(res.body.items[0]).toMatchObject({ actorId: member.id, targetUserId: member.id });
    expect(res.body.items[0].at).toBeTruthy();
    expect((await api().get(`/api/teams/${team.id}/audit`).set(outsider.auth)).status).toBe(403);
  });
});

describe('team formation deadline', () => {
  it('after the deadline: no creating, joining or requesting — but leaving still works', async () => {
    const h = await makeHackathon({ teamFormationClosesAt: new Date(Date.now() + 60_000) });
    const [leader, member, late] = await makeUsers(3);
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);
    expect((await joinWithCode(member, code)).status).toBe(200);

    await Hackathon.updateOne({ _id: h._id }, { $set: { teamFormationClosesAt: new Date(Date.now() - 1000) } });
    clearHackathonCache(); // organiser changed the deadline (in prod this cache is 30 s)

    const create = await api().post(`/api/hackathons/${h._id}/teams`).set(late.auth).send({ name: 'Too Late' });
    const join = await joinWithCode(late, code);
    const req = await api().post(`/api/teams/${team.id}/requests`).set(late.auth).send({});
    for (const r of [create, join, req]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('TEAM_FORMATION_CLOSED');
    }
    expect((await api().post(`/api/teams/${team.id}/leave`).set(member.auth)).status).toBe(200);
  });
});
