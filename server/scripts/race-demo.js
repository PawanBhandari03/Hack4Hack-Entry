/**
 * Live race demo (great for the walkthrough video):
 *   50 real seeded users try to grab the LAST seat of a team at the same instant, over HTTP,
 *   against any deployment. Exactly one should win.
 *
 *   TARGET=https://<api>.onrender.com node scripts/race-demo.js
 *   RACERS=100 TARGET=http://localhost:4000 node scripts/race-demo.js
 *
 * Needs the same MONGODB_URI + JWT_SECRET as the target server (from server/.env): it reads the DB to
 * pick a team and solo users and mints their tokens directly, because logging in 50 users would trip
 * the login rate limit. All the joining itself goes through the public HTTP API.
 *
 * NOTE: this changes real data (one user joins a team). The team it picks is reported so you can show it in the UI.
 */
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Team, Participant, Hackathon } from '../src/models/index.js';
import { signToken } from '../src/middleware/auth.js';
import { checkIntegrity } from '../src/lib/integrity.js';

const TARGET = (process.env.TARGET ?? 'http://localhost:4000').replace(/\/$/, '');
const RACERS = Number(process.env.RACERS ?? 50);

const post = (path, token, body) =>
  fetch(`${TARGET}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

await mongoose.connect(config.mongoUri);
const hackathon = await Hackathon.findOne().lean();

// A team with exactly ONE open seat, accepting members.
const team = await Team.findOne({ hackathonId: hackathon._id, openSeats: 1, lookingForMembers: true }).sort({ updatedAt: -1 }).lean();
if (!team) throw new Error('No team with exactly 1 open seat found');
const racers = await Participant.find({ hackathonId: hackathon._id, teamId: null }).limit(RACERS).lean();
console.log(`Team "${team.name}" (${team.memberCount}/${team.maxSize}, 1 seat left) — ${racers.length} racers`);

// Leader creates a fresh invite code through the API.
const invite = await post(`/api/teams/${team._id}/invites`, signToken(team.leaderId));
if (invite.status !== 201) throw new Error(`invite failed ${invite.status} ${JSON.stringify(invite.body)}`);

// Everyone fires at once.
const t0 = performance.now();
const results = await Promise.all(racers.map((p) => post('/api/invites/redeem', signToken(p.userId), { code: invite.body.code })));
const ms = performance.now() - t0;

const tally = {};
for (const r of results) {
  const k = r.status === 200 ? '200 joined' : `${r.status} ${r.body?.error?.code ?? ''}`;
  tally[k] = (tally[k] ?? 0) + 1;
}
const winner = racers[results.findIndex((r) => r.status === 200)];
console.log(`\n${racers.length} simultaneous joins in ${ms.toFixed(0)} ms:`);
for (const [k, n] of Object.entries(tally)) console.log(`  ${String(n).padStart(3)} × ${k}`);
if (winner) console.log(`  winner: ${winner.name}`);

const after = await Team.findById(team._id).lean();
console.log(`\nTeam now ${after.memberCount}/${after.maxSize}, openSeats=${after.openSeats}`);
const { violations } = await checkIntegrity();
console.log(violations.length ? `INTEGRITY FAIL: ${violations.join('; ')}` : 'Integrity check: all invariants hold ✓');
await mongoose.disconnect();
process.exit(tally['200 joined'] === 1 && !violations.length ? 0 : 1);
