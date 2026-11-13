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
 */
import mongoose from 'mongoose';
import { Team, Participant } from '../models/index.js';
import { teamSummary, personSummary, getHackathonOrThrow } from './teamService.js';
import { badRequest } from '../lib/errors.js';

const CACHE_TTL_MS = 1000;
const cache = new Map(); // key -> { at, value }

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value }); // cache the PROMISE: concurrent misses share one query
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
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

export async function listOpenTeams(hackathonId, { cursor, limit = 20, skill } = {}) {
  await getHackathonOrThrow(hackathonId);
  const key = `teams:${hackathonId}:${cursor ?? ''}:${limit}:${skill ?? ''}`;
  return cached(key, async () => {
    let filter = { hackathonId: new mongoose.Types.ObjectId(hackathonId), lookingForMembers: true, openSeats: { $gt: 0 } };
    if (skill) filter.skillsWanted = skill;
    filter = applyCursor(filter, cursor);
    const { items, nextCursor } = await page(Team, filter, TEAM_FIELDS, limit);
    return { items: items.map(teamSummary), nextCursor };
  });
}

export async function listPeopleLooking(hackathonId, { cursor, limit = 20, skill } = {}) {
  await getHackathonOrThrow(hackathonId);
  const key = `people:${hackathonId}:${cursor ?? ''}:${limit}:${skill ?? ''}`;
  return cached(key, async () => {
    let filter = { hackathonId: new mongoose.Types.ObjectId(hackathonId), teamId: null, lookingForTeam: true };
    if (skill) filter.skills = skill;
    filter = applyCursor(filter, cursor);
    const { items, nextCursor } = await page(Participant, filter, PERSON_FIELDS, limit);
    return { items: items.map(personSummary), nextCursor };
  });
}
