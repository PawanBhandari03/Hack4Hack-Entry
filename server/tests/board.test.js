import { describe, it, expect } from 'vitest';
import { api, makeHackathon, makeUser, makeUsers, createTeamVia, inviteCode, joinWithCode } from './helpers.js';
import { scoreMatch } from '../src/services/suggestionService.js';

describe('board', () => {
  it('lists only teams with open seats, newest first, with cursor pagination', async () => {
    const h = await makeHackathon({ maxTeamSize: 2 });
    const leaders = await makeUsers(5);
    const teams = [];
    for (const l of leaders) teams.push(await createTeamVia(l, h._id));
    // Fill one team -> it must disappear from the board.
    await joinWithCode(await makeUser(), await inviteCode(leaders[0], teams[0].id));

    const viewer = await makeUser();
    const p1 = await api().get(`/api/hackathons/${h._id}/board/teams?limit=2`).set(viewer.auth);
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await api().get(`/api/hackathons/${h._id}/board/teams?limit=2&cursor=${p1.body.nextCursor}`).set(viewer.auth);
    const p3 = await api().get(`/api/hackathons/${h._id}/board/teams?limit=2&cursor=${p2.body.nextCursor}`).set(viewer.auth);
    const ids = [...p1.body.items, ...p2.body.items, ...(p3.body.items ?? [])].map((t) => t.id);
    expect(new Set(ids).size).toBe(4); // no duplicates across pages
    expect(ids).not.toContain(teams[0].id); // full team hidden
  });

  it('lists people looking for a team and respects the opt-out flag', async () => {
    const h = await makeHackathon();
    const [a, b] = await makeUsers(2, { skills: ['python'] });
    await api().get(`/api/hackathons/${h._id}/me`).set(a.auth); // registers
    await api().get(`/api/hackathons/${h._id}/me`).set(b.auth);
    await api().patch(`/api/hackathons/${h._id}/me`).set(b.auth).send({ lookingForTeam: false });
    const res = await api().get(`/api/hackathons/${h._id}/board/people?skill=python`).set(a.auth);
    expect(res.body.items.map((p) => p.userId)).toEqual([a.id]);
  });

  it('rejects a tampered cursor', async () => {
    const h = await makeHackathon();
    const u = await makeUser();
    const res = await api().get(`/api/hackathons/${h._id}/board/teams?cursor=bm9wZQ`).set(u.auth);
    expect(res.status).toBe(400);
  });
});

describe('board stats', () => {
  it('counts teams, open seats, people looking and the most-wanted skills', async () => {
    const h = await makeHackathon({ maxTeamSize: 2 });
    const [l1, l2] = await makeUsers(2);
    const t1 = await createTeamVia(l1, h._id, { skillsWanted: ['python', 'design'] });
    await createTeamVia(l2, h._id, { skillsWanted: ['python'] });
    await joinWithCode(await makeUser(), await inviteCode(l1, t1.id)); // t1 is now full
    const viewer = await makeUser();
    await api().get(`/api/hackathons/${h._id}/me`).set(viewer.auth); // registers, solo + looking

    const res = await api().get(`/api/hackathons/${h._id}/stats`).set(viewer.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ teams: 2, fullTeams: 1, recruitingTeams: 1, openSeats: 1, participants: 4, inTeams: 3, solo: 1, lookingForTeam: 1 });
    expect(res.body.mostWantedSkills).toEqual([{ skill: 'python', teams: 1 }]); // only recruiting teams count
    expect((await api().get(`/api/hackathons/${h._id}/stats`)).status).toBe(401);
  });
});

describe('suggestions', () => {
  it('scoring: complementary skills beat duplicate skills; closer timezone breaks ties', () => {
    const base = { needed: ['design', 'ml'], haveSkills: ['react'], offsetA: 330 };
    const complementary = scoreMatch({ ...base, candidateSkills: ['design', 'ml'], offsetB: 330 });
    const duplicate = scoreMatch({ ...base, candidateSkills: ['react'], offsetB: 330 });
    const farAway = scoreMatch({ ...base, candidateSkills: ['design', 'ml'], offsetB: 330 - 12 * 60 });
    expect(complementary.score).toBe(100);
    expect(duplicate.score).toBe(30); // only the timezone part
    expect(farAway.score).toBe(70); // only the skills part
    expect(complementary.breakdown.matchedSkills).toEqual(['design', 'ml']);
  });

  it('a team leader gets people ranked for the skills the team is missing', async () => {
    const h = await makeHackathon();
    const leader = await makeUser({ skills: ['react'], timezone: 'Asia/Kolkata', utcOffsetMinutes: 330 });
    await createTeamVia(leader, h._id, { skillsWanted: ['react', 'mongodb', 'design'] });
    const good = await makeUser({ skills: ['mongodb', 'design'], utcOffsetMinutes: 330 });
    const meh = await makeUser({ skills: ['design'], utcOffsetMinutes: -300 });
    for (const u of [good, meh]) await api().get(`/api/hackathons/${h._id}/me`).set(u.auth);

    const res = await api().get(`/api/hackathons/${h._id}/suggestions`).set(leader.auth);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('people');
    expect(res.body.neededSkills).toEqual(['mongodb', 'design']); // react already covered
    expect(res.body.items[0].person.userId).toBe(good.id);
    expect(res.body.items[0].score).toBeGreaterThan(res.body.items[1].score);
  });

  it('a solo participant gets teams ranked for them', async () => {
    const h = await makeHackathon();
    const l1 = await makeUser({ skills: ['react'] });
    const l2 = await makeUser({ skills: ['python'] });
    const t1 = await createTeamVia(l1, h._id, { skillsWanted: ['python'] });
    await createTeamVia(l2, h._id, { skillsWanted: ['react'] });
    const me = await makeUser({ skills: ['python'] });
    const res = await api().get(`/api/hackathons/${h._id}/suggestions`).set(me.auth);
    expect(res.body.mode).toBe('teams');
    expect(res.body.items[0].team.id).toBe(t1.id);
  });
});
