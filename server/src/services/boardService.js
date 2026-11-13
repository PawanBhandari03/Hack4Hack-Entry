/**
 * "Looking for teammates" board.
 *
 * Performance choices (target: p95 < 200 ms with 100 concurrent users):
 *  - .lean()          -> plain JS objects, no Mongoose document overhead
 *  - projection       -> only the fields the card needs
 *  - compound index   -> { hackathonId, lookingForMembers, updatedAt, openSeats } matches filter + sort
 *  - cursor pagination-> stable under live inserts, and never does an expensive skip()
 *  - 1 s micro-cache  -> 100 users hitting page 1 at once share one DB query. Live changes still
 *                        arrive instantly over WebSockets, so a 1 s stale first page is invisible.
 *  - cached as a JSON STRING -> JSON.stringify runs once per second, not once per request
 *                        (it was the top CPU cost after the JWT fix).
 */
import mongoose from 'mongoose';
import { Team, Participant } from '../models/index.js';
import { teamSummary, personSummary, getHackathonOrThrow } from './teamService.js';
import { badRequest } from '../lib/errors.js';

const FRESH_MS = 1000; // younger than this: serve as is
const MAX_STALE_MS = 10_000; // between 1 s and 10 s: serve the old copy instantly AND refresh in background
const cache = new Map(); // key -> { at, promise, value?, refreshing? }

/**
 * Micro-cache with stale-while-revalidate.
 *
 * Why not a plain 1 s TTL? Load testing showed that with steady traffic, every time the entry expired
 * a whole burst of users waited for the same DB query (p95 236 ms with only 200 req/s). With SWR, an
 * expired entry is still served instantly while ONE background query refreshes it — users never wait
 * on the database except the very first request (or after 10 s of no traffic).
 * Freshness is still ~1 s, and every change is pushed to clients over WebSockets anyway.
 */
function cached(key, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    const age = now - hit.at;
    if (age < FRESH_MS) return hit.promise;
    if (age < MAX_STALE_MS && 'value' in hit) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        fn()
          .then((value) => cache.set(key, { at: Date.now(), promise: Promise.resolve(value), value }))
          .catch(() => {
            hit.refreshing = false; // keep serving the stale copy, try again next request
          });
      }
      return Promise.resolve(hit.value);
    }
  }
  // Cold (or too old): everyone asking right now shares ONE query (the promise is cached).
  const entry = { at: now };
  entry.promise = fn().then(
    (value) => {
      entry.value = value;
      return value;
    },
    (err) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    }
  );
  cache.set(key, entry);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return entry.promise;
}

export function clearBoardCache() {
  cache.clear();
}

const encodeCursor = (doc) => Buffer.from(`${doc.updatedAt.toISOString()}|${doc._id}`).toString('base64url');

function decodeCursor(cursor) {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()) || !mongoose.isValidObjectId(id)) throw new Error();
    return { date, id: new mongoose.Types.ObjectId(id) };
  } catch {
    throw badRequest('INVALID_CURSOR', 'Invalid pagination cursor');
  }
}

function applyCursor(filter, cursor) {
  if (!cursor) return filter;
  const { date, id } = decodeCursor(cursor);
  return { ...filter, $or: [{ updatedAt: { $lt: date } }, { updatedAt: date, _id: { $lt: id } }] };
}

async function page(model, filter, projection, limit) {
  const docs = await model
    .find(filter, projection)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  return { items, nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null };
}

const TEAM_FIELDS = 'hackathonId name description skillsWanted leaderId memberCount openSeats minSize maxSize lookingForMembers updatedAt';
const PERSON_FIELDS = 'hackathonId userId name skills timezone bio teamId role lookingForTeam joinedTeamAt updatedAt';

/** Resolves to a JSON string (ready to send). */
export async function listOpenTeams(hackathonId, { cursor, limit = 20, skill } = {}) {
  await getHackathonOrThrow(hackathonId);
  const key = `teams:${hackathonId}:${cursor ?? ''}:${limit}:${skill ?? ''}`;
  return cached(key, async () => {
    let filter = { hackathonId: new mongoose.Types.ObjectId(hackathonId), lookingForMembers: true, openSeats: { $gt: 0 } };
    if (skill) filter.skillsWanted = skill;
    filter = applyCursor(filter, cursor);
    const { items, nextCursor } = await page(Team, filter, TEAM_FIELDS, limit);
    return JSON.stringify({ items: items.map(teamSummary), nextCursor });
  });
}

/** Resolves to a JSON string (ready to send). */
export async function listPeopleLooking(hackathonId, { cursor, limit = 20, skill } = {}) {
  await getHackathonOrThrow(hackathonId);
  const key = `people:${hackathonId}:${cursor ?? ''}:${limit}:${skill ?? ''}`;
  return cached(key, async () => {
    let filter = { hackathonId: new mongoose.Types.ObjectId(hackathonId), teamId: null, lookingForTeam: true };
    if (skill) filter.skills = skill;
    filter = applyCursor(filter, cursor);
    const { items, nextCursor } = await page(Participant, filter, PERSON_FIELDS, limit);
    return JSON.stringify({ items: items.map(personSummary), nextCursor });
  });
}
