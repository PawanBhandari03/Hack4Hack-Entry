/**
 * CONCURRENCY TESTS — the #1 judging criterion.
 * Every request in these tests is fired at the same time with Promise.all.
 */
import { describe, it, expect } from 'vitest';
import { api, makeHackathon, makeUser, makeUsers, createTeamVia, inviteCode, joinWithCode } from './helpers.js';
import { Team, Participant, AuditLog, JoinRequest } from '../src/models/index.js';

async function teamWithOneSeatLeft() {
  const h = await makeHackathon({ maxTeamSize: 4 });
  const leader = await makeUser();
  const team = await createTeamVia(leader, h._id);
  const code = await inviteCode(leader, team.id);
  for (const m of await makeUsers(2)) expect((await joinWithCode(m, code)).status).toBe(200);
  const t = await Team.findById(team.id).lean();
  expect(t.openSeats).toBe(1);
  return { h, leader, team, code };
}

describe('race: last seat', () => {
  it('50 people redeem an invite for the LAST seat at the same instant -> exactly one wins', async () => {
    const { team, code } = await teamWithOneSeatLeft();
    const racers = await makeUsers(50);

    const results = await Promise.all(racers.map((u) => joinWithCode(u, code)));

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(49);
    expect(losers.every((r) => r.body.error.code === 'TEAM_FULL')).toBe(true);

    // The database agrees with the responses — no over-filled team, no ghost members.
    const t = await Team.findById(team.id).lean();
    expect(t.memberCount).toBe(4);
    expect(t.openSeats).toBe(0);
    expect(await Participant.countDocuments({ teamId: team.id })).toBe(4);
    expect(await AuditLog.countDocuments({ teamId: team.id, action: 'MEMBER_JOINED' })).toBe(3);
  });

  it('leader accepts 10 pending requests at once with 1 seat left -> exactly one accepted', async () => {
    const { leader, team } = await teamWithOneSeatLeft();
    const requesters = await makeUsers(10);
    const reqIds = [];
    for (const u of requesters) {
      const r = await api().post(`/api/teams/${team.id}/requests`).set(u.auth).send({});
      expect(r.status).toBe(201);
      reqIds.push(r.body.request.id);
    }

    const results = await Promise.all(reqIds.map((id) => api().post(`/api/requests/${id}/accept`).set(leader.auth)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const t = await Team.findById(team.id).lean();
    expect(t.memberCount).toBe(4);
    expect(await Participant.countDocuments({ teamId: team.id })).toBe(4);
    expect(await JoinRequest.countDocuments({ teamId: team.id, status: 'accepted' })).toBe(1);
  });
});

describe('race: one team per person', () => {
  it('one user joins 5 different teams simultaneously -> ends up in exactly one', async () => {
    const h = await makeHackathon();
    const leaders = await makeUsers(5);
    const codes = [];
    for (const l of leaders) {
      const t = await createTeamVia(l, h._id);
      codes.push(await inviteCode(l, t.id));
    }
    const u = await makeUser();

    const results = await Promise.all(codes.map((c) => joinWithCode(u, c)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_IN_TEAM')).toBe(true);
    const p = await Participant.findOne({ hackathonId: h._id, userId: u.id }).lean();
    expect(p.teamId).not.toBeNull();
    const total = await Team.aggregate([{ $match: { hackathonId: h._id } }, { $group: { _id: null, n: { $sum: '$memberCount' } } }]);
    expect(total[0].n).toBe(6); // 5 leaders + 1 user, never 10
  });

  it('a user creating 10 teams at once (no idempotency key) creates exactly one', async () => {
    const h = await makeHackathon();
    const u = await makeUser();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api().post(`/api/hackathons/${h._id}/teams`).set(u.auth).send({ name: `Team ${i}` }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Team.countDocuments({ hackathonId: h._id })).toBe(1);
  });
});

describe('race: leaving', () => {
  it('all 4 members leave at the same time -> team deleted exactly once, counts never negative', async () => {
    const h = await makeHackathon({ maxTeamSize: 4 });
    const leader = await makeUser();
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);
    const members = await makeUsers(3);
    for (const m of members) expect((await joinWithCode(m, code)).status).toBe(200);

    const results = await Promise.all([leader, ...members].map((u) => api().post(`/api/teams/${team.id}/leave`).set(u.auth)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.deleted)).toHaveLength(1);
    expect(await Team.countDocuments({ _id: team.id })).toBe(0);
    expect(await Participant.countDocuments({ teamId: team.id })).toBe(0);
    expect(await AuditLog.countDocuments({ teamId: team.id, action: 'TEAM_DELETED' })).toBe(1);
  });
});
