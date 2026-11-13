/**
 * Load test for the "looking for teammates" board.
 * Requirement: p95 < 200 ms on the board endpoint with 100 concurrent users.
 *
 * Four runs:
 *   0. Virtual users - 100 k6-style users: request, wait for the answer, think 0.5–1.5 s (the requirement)
 *   1. Burst         - all 100 connections fire at the same instant, twice per second (stress test)
 *   2. Saturation    - 100 connections, zero think time, page 1 only (as fast as the server can go)
 *   3. Saturation    - mix of page 1, page 2 (cursor), people tab, skill filter
 *
 *   TARGET=http://localhost:4000 node scripts/loadtest.js
 *   TARGET=https://<api> DURATION=60 node scripts/loadtest.js
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

/**
 * k6-style virtual users: each VU loops "request -> wait for the response -> think for a random
 * 0.5–1.5 s", for DURATION seconds. Start times are staggered randomly over the first second.
 * This is how k6 models N concurrent users (`http.get(); sleep(1)`), and it doesn't synchronise
 * everyone into the same millisecond the way a fixed per-connection rate does.
 */
async function virtualUsers(name, url, headers) {
  const times = [];
  const statuses = {};
  let errors = 0;
  const end = Date.now() + DURATION * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vu = async () => {
    await sleep(Math.random() * 1000);
    while (Date.now() < end) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { headers });
        await res.arrayBuffer();
        times.push(performance.now() - t0);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      } catch {
        errors++;
      }
      await sleep(500 + Math.random() * 1000);
    }
  };
  await Promise.all(Array.from({ length: CONNECTIONS }, vu));
  times.sort((a, b) => a - b);
  const summary = {
    name,
    target: TARGET,
    virtualUsers: CONNECTIONS,
    durationSec: DURATION,
    requests: times.length,
    rps: Number((times.length / DURATION).toFixed(1)),
    statuses,
    errors,
    timeouts: 0,
    latencyMs: {
      p50: percentile(times, 50),
      p90: percentile(times, 90),
      p95: percentile(times, 95),
      p99: percentile(times, 99),
      max: times[times.length - 1],
    },
  };
  summary.pass = summary.latencyMs.p95 < 200 && errors === 0 && Object.keys(statuses).every((s) => s === '200');
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
  // 0) k6-style virtual users: the standard model of "100 concurrent users".
  const vus = await virtualUsers(
    `${CONNECTIONS} virtual users (k6-style): GET /board/teams, think 0.5–1.5 s`,
    `${TARGET}/api/hackathons/${hackathonId}/board/teams?limit=20`,
    headers
  );
  // 1) Burst stress: all 100 connections fire at the SAME instant, twice per second (worst-case herd).
  const realistic = await run(
    'Burst: 100 users fire together every 500 ms (200 req/s)',
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

  const report = { at: new Date().toISOString(), target: TARGET, runs: [vus, realistic, boardTeams, boardMixed] };
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
