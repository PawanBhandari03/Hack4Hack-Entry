/**
 * Load test for the "looking for teammates" board.
 * Requirement: p95 < 200 ms on the board endpoint with 100 concurrent users.
 *
 * Three runs:
 *   1. Realistic  - 100 users, each requesting the board twice per second (200 req/s total)
 *   2. Saturation - 100 connections, zero think time, page 1 only (as fast as the server can go)
 *   3. Saturation - mix of page 1, page 2 (cursor), people tab, skill filter
 *
 *   TARGET=http://localhost:4000 node scripts/loadtest.js
 *   TARGET=https://<render-app>.onrender.com DURATION=60 node scripts/loadtest.js
 *
 * autocannon reports p90/p97.5/p99 but NOT p95, so we record every response time ourselves
 * and compute exact percentiles. Results go to loadtest-results/<timestamp>.json and a summary is printed.
 */
import autocannon from 'autocannon';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = (process.env.TARGET ?? 'http://localhost:4000').replace(/\/$/, '');
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 100);
const DURATION = Number(process.env.DURATION ?? 30);
const EMAIL = process.env.EMAIL ?? 'demo1@hack4hack.dev';
const PASSWORD = process.env.PASSWORD ?? 'password123';

async function json(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${opts?.method ?? 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function run(name, requests, extra = {}) {
  const times = [];
  const statuses = {};
  const instance = autocannon({
    url: TARGET,
    connections: CONNECTIONS,
    duration: DURATION,
    requests,
    ...extra,
  });
  instance.on('response', (_client, statusCode, _bytes, responseTime) => {
    times.push(responseTime);
    statuses[statusCode] = (statusCode in statuses ? statuses[statusCode] : 0) + 1;
  });
  const result = await instance;
  times.sort((a, b) => a - b);
  const summary = {
    name,
    target: TARGET,
    connections: CONNECTIONS,
    durationSec: DURATION,
    ratePerConnection: extra.connectionRate ?? 'unlimited',
    requests: times.length,
    rps: Number(result.requests.average.toFixed(1)),
    statuses,
    errors: result.errors,
    timeouts: result.timeouts,
    latencyMs: {
      p50: percentile(times, 50),
      p90: percentile(times, 90),
      p95: percentile(times, 95),
      p99: percentile(times, 99),
      max: times[times.length - 1],
    },
  };
  summary.pass = summary.latencyMs.p95 < 200 && Object.keys(statuses).every((s) => s === '200');
  return summary;
}

async function main() {
  console.log(`Target ${TARGET} — ${CONNECTIONS} concurrent connections for ${DURATION}s each`);
  const { token } = await json(`${TARGET}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const { items } = await json(`${TARGET}/api/hackathons`);
  const hackathonId = items[0].id;
  const headers = { Authorization: `Bearer ${token}` };

  // Warm-up (wakes a sleeping free-tier instance, fills connection pools).
  for (let i = 0; i < 5; i++) await json(`${TARGET}/api/hackathons/${hackathonId}/board/teams`, { headers });

  const first = await json(`${TARGET}/api/hackathons/${hackathonId}/board/teams?limit=20`, { headers });
  // 1) Realistic: 100 users each refreshing the board twice a second (200 req/s total).
  const realistic = await run(
    'Realistic: 100 users x 2 req/s on /board/teams',
    [{ method: 'GET', path: `/api/hackathons/${hackathonId}/board/teams?limit=20`, headers }],
    { connectionRate: 2 }
  );
  // 2) Saturation: 100 connections firing back-to-back with zero think time (worst case).
  const boardTeams = await run('Saturation: GET /board/teams (page 1), no think time', [
    { method: 'GET', path: `/api/hackathons/${hackathonId}/board/teams?limit=20`, headers },
  ]);
  const boardMixed = await run('Saturation: board mix (teams p1/p2 + people + skill filter)', [
    { method: 'GET', path: `/api/hackathons/${hackathonId}/board/teams?limit=20`, headers },
    { method: 'GET', path: `/api/hackathons/${hackathonId}/board/teams?limit=20&cursor=${first.nextCursor}`, headers },
    { method: 'GET', path: `/api/hackathons/${hackathonId}/board/people?limit=20`, headers },
    { method: 'GET', path: `/api/hackathons/${hackathonId}/board/teams?limit=20&skill=react`, headers },
  ]);

  const report = { at: new Date().toISOString(), runs: [realistic, boardTeams, boardMixed] };
  const dir = path.resolve('loadtest-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  for (const r of report.runs) {
    console.log(`\n${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    console.log(`  requests=${r.requests}  rps=${r.rps}  statuses=${JSON.stringify(r.statuses)}  errors=${r.errors} timeouts=${r.timeouts}`);
    console.log(`  latency ms: p50=${r.latencyMs.p50} p90=${r.latencyMs.p90} p95=${r.latencyMs.p95} p99=${r.latencyMs.p99} max=${r.latencyMs.max}`);
  }
  console.log(`\nSaved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
