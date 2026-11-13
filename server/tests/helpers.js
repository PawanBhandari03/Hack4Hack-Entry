import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { Hackathon, User } from '../src/models/index.js';
import { signToken } from '../src/middleware/auth.js';

export const app = createApp();
export const api = () => request(app);

export async function makeHackathon(overrides = {}) {
  return Hackathon.create({
    name: 'Test Hack',
    slug: `test-${crypto.randomUUID()}`,
    minTeamSize: 2,
    maxTeamSize: 4,
    ...overrides,
  });
}

const FAST_HASH = bcrypt.hashSync('password123', 4);

/** Create a user directly in the DB (fast) and return { user, token, auth } */
export async function makeUser(overrides = {}) {
  const n = crypto.randomUUID().slice(0, 8);
  const user = await User.create({
    name: `User ${n}`,
    email: `u${n}@test.dev`,
    passwordHash: FAST_HASH,
    skills: [],
    timezone: 'UTC',
    utcOffsetMinutes: 0,
    ...overrides,
  });
  const token = signToken(user._id);
  return { user, id: String(user._id), token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeUsers(count, overrides = {}) {
  return Promise.all(Array.from({ length: count }, () => makeUser(overrides)));
}

export async function createTeamVia(u, hackathonId, body = {}) {
  const res = await api()
    .post(`/api/hackathons/${hackathonId}/teams`)
    .set(u.auth)
    .send({ name: `Team ${crypto.randomUUID().slice(0, 6)}`, ...body });
  if (res.status !== 201) throw new Error(`createTeam failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.team;
}

export async function inviteCode(leader, teamId) {
  const res = await api().post(`/api/teams/${teamId}/invites`).set(leader.auth);
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.code;
}

export async function joinWithCode(u, code) {
  return api().post('/api/invites/redeem').set(u.auth).send({ code });
}

export const key = () => `k-${crypto.randomUUID()}`;
