/**
 * CHAOS TEST (bonus): kill the API server with SIGKILL in the middle of a burst of joins/leaves,
 * restart it, retry the requests that never got an answer (same Idempotency-Key), and prove:
 *   - every team-formation invariant still holds (checkIntegrity() finds 0 violations)
 *   - nobody who got "200 joined" is missing from that team
 *
 * Why it works: each join/leave is ONE MongoDB transaction. A process killed mid-transaction never
 * commits, so the database only ever contains complete before/after states — never "half a join".
 */
import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { makeHackathon, makeUsers, createTeamVia, inviteCode } from './helpers.js';
import { checkIntegrity } from '../src/lib/integrity.js';
import { Participant } from '../src/models/index.js';
import { syncAllIndexes } from '../src/models/index.js';

const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

function startServer() {
  const uri = inject('mongoUri').replace('/?', `/${mongoose.connection.name}?`);
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MONGODB_URI: uri,
      PORT: String(PORT),
      JWT_SECRET: 'test-secret', // same secret as the tests, so test tokens are valid
      RATE_LIMIT_ENABLED: 'false',
      IDEMPOTENCY_STALE_MS: '1000',
    },
    stdio: 'ignore',
  });
  return waitForHealth();
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const call = (op) =>
  fetch(`${BASE}${op.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${op.token}`, 'Idempotency-Key': op.key },
    body: JSON.stringify(op.body ?? {}),
  })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .catch(() => ({ status: 'NETWORK' })); // connection died with the server

beforeAll(async () => {
  await syncAllIndexes();
});

afterAll(() => {
  child?.kill('SIGKILL');
});

describe('chaos: server killed mid-join', () => {
  it('no corruption after SIGKILL during 340 concurrent joins/leaves', { timeout: 120_000 }, async () => {
    const h = await makeHackathon({ maxTeamSize: 4 });
    const leaders = await makeUsers(40);
    const teams = [];
    for (const l of leaders) {
      const t = await createTeamVia(l, h._id);
      teams.push({ ...t, code: await inviteCode(l, t.id), leader: l });
    }
    const joiners = await makeUsers(300);

    // 300 joins (only 120 seats exist) + 40 leaders leaving (leader transfer / team deletion races).
    const ops = [
      ...joiners.map((u, i) => ({ kind: 'join', user: u, team: teams[i % teams.length], token: u.token, path: '/api/invites/redeem', body: { code: teams[i % teams.length].code } })),
      ...teams.map((t) => ({ kind: 'leave', user: t.leader, team: t, token: t.leader.token, path: `/api/teams/${t.id}/leave` })),
    ]
      .map((op) => ({ ...op, key: `chaos-${crypto.randomUUID()}` }))
      .sort(() => Math.random() - 0.5);

    await startServer();

    // Fire everything at once; SIGKILL the server as soon as the first 40 responses are back.
    let done = 0;
    const firstPass = ops.map((op) =>
      call(op).then((res) => {
        if (++done === 40) child.kill('SIGKILL');
        return res;
      })
    );
    const results = await Promise.all(firstPass);
    const lost = results.filter((r) => r.status === 'NETWORK').length;
    expect(lost).toBeGreaterThan(0); // the kill really happened mid-flight

    // Restart and retry ONLY the requests that never got an answer, with the SAME idempotency key.
    await startServer();
    for (let i = 0; i < ops.length; i++) {
      // Retry exactly like the real client (client/src/api.js): network errors, REQUEST_IN_PROGRESS,
      // and 503 TRY_AGAIN (seen on a slow, memory-starved machine while the restarted server warms up).
      const pending = (r) => r.status === 'NETWORK' || r.status === 503 || r.body?.error?.code === 'REQUEST_IN_PROGRESS';
      for (let attempt = 0; pending(results[i]); attempt++) {
        if (attempt > 30) throw new Error('retry never settled');
        if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
        results[i] = await call(ops[i]);
      }
    }

    // 1) No invariant is broken.
    const report = await checkIntegrity();
    expect(report.violations).toEqual([]);

    // 2) Every confirmed join is real (unless that member later... nobody but leaders leave here).
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].kind !== 'join' || results[i].status !== 200) continue;
      const p = await Participant.findOne({ hackathonId: h._id, userId: ops[i].user.id }).lean();
      expect(String(p.teamId)).toBe(ops[i].team.id);
    }

    // 3) Every request ended with a definite answer.
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => [200, 404, 409].includes(s))).toBe(true);
    console.log(`chaos: ${lost} requests lost in the crash, all retried; final statuses`, countBy(statuses));
  });
});

const countBy = (arr) => arr.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
