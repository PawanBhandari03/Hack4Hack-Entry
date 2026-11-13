/**
 * Teammate suggestions.
 *
 * SCORING (each part is 0..1, final score 0..100):
 *
 *   score = 100 * (0.7 * skillScore + 0.3 * timezoneScore)
 *
 *   skillScore    — "do they bring what the team is MISSING?"
 *                   needed  = team.skillsWanted minus skills members already have
 *                             (if the leader listed nothing, every skill the team lacks counts as new)
 *                   skillScore = |candidate.skills ∩ needed| / |needed|
 *                   So a candidate who duplicates existing skills scores 0 — that's what makes it
 *                   "complementary" rather than "similar".
 *
 *   timezoneScore — "can they actually work together live?"
 *                   hours = circular distance between UTC offsets (max 12h)
 *                   timezoneScore = 1 - hours / 12   (same tz = 1, opposite side of the world = 0)
 *
 * Why 70/30: complementary skills decide whether the team can build the project at all;
 * timezone only decides how convenient collaboration is. Weights are constants, easy to tune.
 *
 * Two directions:
 *   - caller is in a team  -> rank PEOPLE (without a team, looking) for that team
 *   - caller has no team   -> rank open TEAMS for the caller
 */
import { Participant, Team } from '../models/index.js';
import { ensureParticipant, personSummary, teamSummary } from './teamService.js';
import { hoursApart } from '../lib/timezone.js';

export const WEIGHTS = { skills: 0.7, timezone: 0.3 };
const CANDIDATE_POOL = 500; // score at most this many candidates in memory

const norm = (s) => s.trim().toLowerCase();

function circularMeanOffset(offsets) {
  // Average on a circle so UTC+11 and UTC-11 average to UTC±12, not UTC+0.
  if (!offsets.length) return 0;
  let x = 0;
  let y = 0;
  for (const o of offsets) {
    const a = (o / (24 * 60)) * 2 * Math.PI;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return Math.round((Math.atan2(y, x) / (2 * Math.PI)) * 24 * 60);
}

export function scoreMatch({ needed, haveSkills, candidateSkills, offsetA, offsetB }) {
  const cand = new Set(candidateSkills.map(norm));
  let neededSet = new Set(needed.map(norm));
  if (neededSet.size === 0) {
    // Nothing explicitly wanted: reward skills the team doesn't have yet.
    const have = new Set(haveSkills.map(norm));
    neededSet = new Set([...cand].filter((s) => !have.has(s)));
    const skillScore = cand.size ? neededSet.size / cand.size : 0;
    return finish(skillScore, [...neededSet], offsetA, offsetB);
  }
  const matched = [...neededSet].filter((s) => cand.has(s));
  return finish(matched.length / neededSet.size, matched, offsetA, offsetB);
}

function finish(skillScore, matchedSkills, offsetA, offsetB) {
  const hours = hoursApart(offsetA, offsetB);
  const timezoneScore = 1 - hours / 12;
  const score = Math.round(100 * (WEIGHTS.skills * skillScore + WEIGHTS.timezone * timezoneScore));
  return {
    score,
    breakdown: {
      skillScore: Number(skillScore.toFixed(2)),
      timezoneScore: Number(timezoneScore.toFixed(2)),
      matchedSkills,
      hoursApart: Number(hours.toFixed(1)),
    },
  };
}

export async function getSuggestions(hackathonId, userId, limit = 10) {
  const me = await ensureParticipant(hackathonId, userId);

  if (me.teamId) {
    const team = await Team.findById(me.teamId).lean();
    const members = await Participant.find({ teamId: me.teamId }).select('skills utcOffsetMinutes').lean();
    const haveSkills = [...new Set(members.flatMap((m) => m.skills.map(norm)))];
    const needed = team.skillsWanted.map(norm).filter((s) => !haveSkills.includes(s));
    const teamOffset = circularMeanOffset(members.map((m) => m.utcOffsetMinutes));

    const filter = { hackathonId: me.hackathonId, teamId: null, lookingForTeam: true };
    if (needed.length) filter.skills = { $in: needed }; // index { hackathonId, teamId, skills }
    const candidates = await Participant.find(filter).limit(CANDIDATE_POOL).lean();

    const ranked = candidates
      .map((c) => ({
        person: personSummary(c),
        ...scoreMatch({ needed, haveSkills, candidateSkills: c.skills, offsetA: teamOffset, offsetB: c.utcOffsetMinutes }),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { mode: 'people', weights: WEIGHTS, neededSkills: needed, items: ranked };
  }

  const teams = await Team.find({ hackathonId: me.hackathonId, lookingForMembers: true, openSeats: { $gt: 0 } })
    .sort({ updatedAt: -1 })
    .limit(CANDIDATE_POOL)
    .lean();
  const teamIds = teams.map((t) => t._id);
  const members = await Participant.find({ teamId: { $in: teamIds } }).select('teamId skills utcOffsetMinutes').lean();
  const byTeam = new Map();
  for (const m of members) {
    const k = String(m.teamId);
    if (!byTeam.has(k)) byTeam.set(k, []);
    byTeam.get(k).push(m);
  }
  const ranked = teams
    .map((t) => {
      const ms = byTeam.get(String(t._id)) ?? [];
      const haveSkills = [...new Set(ms.flatMap((m) => m.skills.map(norm)))];
      const needed = t.skillsWanted.map(norm).filter((s) => !haveSkills.includes(s));
      return {
        team: teamSummary(t),
        ...scoreMatch({
          needed,
          haveSkills,
          candidateSkills: me.skills,
          offsetA: circularMeanOffset(ms.map((m) => m.utcOffsetMinutes)),
          offsetB: me.utcOffsetMinutes,
        }),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { mode: 'teams', weights: WEIGHTS, items: ranked };
}
