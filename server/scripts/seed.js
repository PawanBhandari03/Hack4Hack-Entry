/**
 * Seed: 10,000 users and 2,000 teams in one hackathon.
 *
 *   npm run seed            -> wipes ALL collections in the target DB, then seeds
 *   USERS=2000 TEAMS=400 npm run seed   -> smaller run
 *   SEED_IF_EMPTY=true npm run seed      -> only seeds an empty DB (used by docker compose)
 *
 * Fast because:
 *  - the bcrypt hash is computed ONCE and reused (hashing 10k passwords would take minutes)
 *  - documents are built in memory with pre-generated ObjectIds and written with insertMany in batches
 *
 * Every seeded team is internally consistent: memberCount === number of Participants with that teamId,
 * openSeats === maxSize - memberCount, the leader is the earliest-joined member.
 *
 * Demo logins (password "password123"): demo1@hack4hack.dev ... demo5@hack4hack.dev (no team yet).
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { Hackathon, User, Participant, Team, AuditLog, allModels, syncAllIndexes } from '../src/models/index.js';
import { utcOffsetMinutes } from '../src/lib/timezone.js';

const USERS = Number(process.env.USERS ?? 10_000);
const TEAMS = Number(process.env.TEAMS ?? 2_000);
const BATCH = 1000;
const PASSWORD = 'password123';

const SKILLS = ['react', 'node.js', 'mongodb', 'python', 'ml', 'design', 'figma', 'go', 'rust', 'java', 'kotlin', 'swift',
  'flutter', 'devops', 'aws', 'docker', 'postgres', 'typescript', 'graphql', 'web3', 'data science', 'product', 'ui', 'ux'];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York',
  'America/Los_Angeles', 'America/Sao_Paulo', 'Africa/Lagos', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Liam', 'Emma', 'Noah', 'Olivia', 'Mateo', 'Sofia',
  'Chen', 'Yuki', 'Amara', 'Tunde', 'Lucas', 'Mia', 'Arjun', 'Isha', 'Omar', 'Lea', 'Ivan', 'Zara'];
const LAST = ['Sharma', 'Patel', 'Singh', 'Khan', 'Smith', 'Garcia', 'Kim', 'Tanaka', 'Okafor', 'Silva', 'Muller', 'Rossi',
  'Chen', 'Nguyen', 'Brown', 'Lopez', 'Iyer', 'Das', 'Ali', 'Novak'];
const ADJ = ['Quantum', 'Rapid', 'Silent', 'Neon', 'Cosmic', 'Binary', 'Crimson', 'Atomic', 'Lunar', 'Hyper', 'Pixel', 'Turbo'];
const NOUN = ['Falcons', 'Coders', 'Wizards', 'Pandas', 'Rockets', 'Ninjas', 'Owls', 'Builders', 'Hackers', 'Tigers', 'Foxes', 'Comets'];

// Deterministic PRNG so every seed run produces the same data (reproducible load tests).
let s = 42;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickMany = (arr, n) => [...new Set(Array.from({ length: n }, () => pick(arr)))];

async function insertBatched(model, docs) {
  for (let i = 0; i < docs.length; i += BATCH) {
    await model.insertMany(docs.slice(i, i + BATCH), { ordered: false, lean: true });
  }
}

async function main() {
  const t0 = Date.now();
  await mongoose.connect(config.mongoUri);
  if (process.env.SEED_IF_EMPTY === 'true' && (await User.estimatedDocumentCount()) > 0) {
    console.log('Database already has data, skipping seed (SEED_IF_EMPTY=true).');
    await mongoose.disconnect();
    return;
  }
  console.log(`Connected. Wiping collections in "${mongoose.connection.name}"...`);
  for (const m of allModels) await m.deleteMany({});
  await syncAllIndexes();

  const hackathon = await Hackathon.create({
    name: 'Hack4Hack Demo Hackathon 2026',
    slug: 'hack4hack-demo-2026',
    description: 'Demo hackathon with 10,000 participants for the team-formation service.',
    minTeamSize: 2,
    maxTeamSize: 4,
    // Far enough out that reviewers can still try everything during the interview weeks.
    teamFormationClosesAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
  });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const offsets = Object.fromEntries(TIMEZONES.map((tz) => [tz, utcOffsetMinutes(tz)]));
  const base = Date.now() - 7 * 24 * 3600 * 1000;

  // ---- users ----
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const tz = pick(TIMEZONES);
    const demo = i < 5;
    users.push({
      _id: new mongoose.Types.ObjectId(),
      name: demo ? `Demo User ${i + 1}` : `${pick(FIRST)} ${pick(LAST)}`,
      email: demo ? `demo${i + 1}@hack4hack.dev` : `user${i + 1}@seed.hack4hack.dev`,
      passwordHash,
      skills: pickMany(SKILLS, 1 + Math.floor(rand() * 4)),
      timezone: tz,
      utcOffsetMinutes: offsets[tz],
      bio: '',
      createdAt: new Date(base + i * 1000),
      updatedAt: new Date(base + i * 1000),
    });
  }
  await insertBatched(User, users);
  console.log(`Users: ${users.length}`);

  // ---- teams: assign members from the non-demo pool ----
  const pool = users.slice(5);
  let cursor = 0;
  const teams = [];
  const participants = [];
  const audits = [];
  const usedNames = new Set();
  for (let t = 0; t < TEAMS && cursor < pool.length; t++) {
    const size = Math.min(1 + Math.floor(rand() * hackathon.maxTeamSize), pool.length - cursor); // 1..4
    const members = pool.slice(cursor, cursor + size);
    cursor += size;
    const teamId = new mongoose.Types.ObjectId();
    let name;
    do name = `${pick(ADJ)} ${pick(NOUN)} ${Math.floor(rand() * 1000)}`;
    while (usedNames.has(name.toLowerCase()));
    usedNames.add(name.toLowerCase());
    const created = new Date(base + 3600_000 + t * 60_000);
    teams.push({
      _id: teamId,
      hackathonId: hackathon._id,
      name,
      nameKey: name.toLowerCase(),
      description: `We are building something cool with ${pickMany(SKILLS, 2).join(' and ')}.`,
      skillsWanted: pickMany(SKILLS, 1 + Math.floor(rand() * 3)),
      leaderId: members[0]._id,
      memberCount: members.length,
      openSeats: hackathon.maxTeamSize - members.length,
      minSize: hackathon.minTeamSize,
      maxSize: hackathon.maxTeamSize,
      lookingForMembers: rand() < 0.9,
      createdAt: created,
      updatedAt: new Date(created.getTime() + Math.floor(rand() * 3 * 24 * 3600_000)),
    });
    members.forEach((u, idx) => {
      participants.push({
        hackathonId: hackathon._id,
        userId: u._id,
        name: u.name,
        skills: u.skills,
        timezone: u.timezone,
        utcOffsetMinutes: u.utcOffsetMinutes,
        bio: '',
        teamId,
        role: idx === 0 ? 'leader' : 'member',
        joinedTeamAt: new Date(created.getTime() + idx * 1000),
        lookingForTeam: false,
        createdAt: created,
        updatedAt: created,
      });
    });
    audits.push({ hackathonId: hackathon._id, teamId, actorId: members[0]._id, action: 'TEAM_CREATED', details: { seeded: true }, createdAt: created });
  }

  // ---- everyone else: registered, no team, 75% looking ----
  for (const u of [...users.slice(0, 5), ...pool.slice(cursor)]) {
    participants.push({
      hackathonId: hackathon._id,
      userId: u._id,
      name: u.name,
      skills: u.skills,
      timezone: u.timezone,
      utcOffsetMinutes: u.utcOffsetMinutes,
      bio: '',
      teamId: null,
      role: null,
      joinedTeamAt: null,
      lookingForTeam: rand() < 0.75,
      createdAt: u.createdAt,
      updatedAt: new Date(u.createdAt.getTime() + Math.floor(rand() * 3 * 24 * 3600_000)),
    });
  }

  await insertBatched(Team, teams);
  await insertBatched(Participant, participants);
  await insertBatched(AuditLog, audits);

  const inTeams = participants.filter((p) => p.teamId).length;
  console.log(`Teams: ${teams.length} (members: ${inTeams}), solo participants: ${participants.length - inTeams}`);
  console.log(`Hackathon id: ${hackathon._id}`);
  console.log(`Demo login: demo1@hack4hack.dev / ${PASSWORD}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
