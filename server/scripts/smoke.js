/**
 * Post-deploy smoke test: about 5 seconds, read-only, safe to run against production at any time.
 *
 *   TARGET=https://<api> ORIGIN=https://<app>.vercel.app npm run smoke
 *
 * Checks: /health, hackathon list, demo login, board (teams + people), CORS for the frontend origin,
 * and a real WebSocket connection that subscribes to the live board. Exits 1 if any check fails.
 */
import { io } from 'socket.io-client';

const TARGET = (process.env.TARGET ?? 'http://localhost:4000').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const EMAIL = process.env.EMAIL ?? 'demo1@hack4hack.dev';
const PASSWORD = process.env.PASSWORD ?? 'password123';

let failed = 0;
async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    console.log(`PASS  ${name}  (${Math.round(performance.now() - t0)} ms)${detail ? `  ${detail}` : ''}`);
    return true;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}  ${err.message}`);
    return false;
  }
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${TARGET}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

console.log(`Smoke test against ${TARGET} (frontend origin ${ORIGIN})\n`);

let token;
let hackathonId;

await check('GET /health', async () => {
  const body = await getJson('/health');
  if (!body.ok) throw new Error(JSON.stringify(body));
});

await check('GET /api/hackathons', async () => {
  const { items } = await getJson('/api/hackathons');
  if (!items?.length) throw new Error('no hackathons (did the server start and seed?)');
  hackathonId = items[0].id;
  return `"${items[0].name}"`;
});

await check(`POST /api/auth/login (${EMAIL})`, async () => {
  const res = await fetch(`${TARGET}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()} (seeded? rate-limited?)`);
  token = (await res.json()).token;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

await check('GET board/teams', async () => {
  const { items } = await getJson(`/api/hackathons/${hackathonId}/board/teams?limit=20`, auth());
  return `${items.length} teams on page 1`;
});

await check('GET board/people', async () => {
  const { items } = await getJson(`/api/hackathons/${hackathonId}/board/people?limit=20`, auth());
  return `${items.length} people on page 1`;
});

await check(`CORS allows ${ORIGIN}`, async () => {
  const res = await fetch(`${TARGET}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  const allowed = res.headers.get('access-control-allow-origin');
  if (allowed !== ORIGIN && allowed !== '*') {
    throw new Error(`allow-origin is ${allowed ?? 'missing'}: add ${ORIGIN} to CLIENT_ORIGIN on the API`);
  }
});

await check('WebSocket connects and subscribes to the live board', () =>
  new Promise((resolve, reject) => {
    const socket = io(TARGET, { auth: { token }, transports: ['websocket'], extraHeaders: { Origin: ORIGIN }, reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out after 10 s (does the host support WebSockets?)'));
    }, 10_000);
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`connect_error: ${err.message}`));
    });
    socket.on('connect', () => {
      socket.emit('board:subscribe', hackathonId, (ack) => {
        clearTimeout(timer);
        socket.close();
        if (ack?.ok) resolve('websocket transport');
        else reject(new Error(`subscribe ack ${JSON.stringify(ack)}`));
      });
    });
  })
);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
