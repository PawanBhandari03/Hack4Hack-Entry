/**
 * Data-integrity checker. Returns a list of violations (empty list = healthy).
 *
 * Invariants that must ALWAYS hold, no matter how many concurrent requests or crashes happened:
 *   1. team.memberCount === number of Participants whose teamId is that team
 *   2. team.openSeats === team.maxSize - team.memberCount, and 1 <= memberCount <= maxSize
 *   3. exactly one Participant in the team has role "leader", and it is team.leaderId
 *   4. no Participant points to a team that doesn't exist
 *   5. no person has two Participant rows in the same hackathon
 *
 * Used by: the chaos test (after killing the server mid-join), the race tests, and
 * `npm run verify` against the real database.
 */
import { Team, Participant } from '../models/index.js';

export async function checkIntegrity() {
  const violations = [];

  const roster = await Participant.aggregate([
    { $match: { teamId: { $ne: null } } },
    {
      $group: {
        _id: '$teamId',
        members: { $sum: 1 },
        leaders: { $push: { $cond: [{ $eq: ['$role', 'leader'] }, '$userId', '$$REMOVE'] } },
      },
    },
  ]);
  const byTeam = new Map(roster.map((r) => [String(r._id), r]));

  const teams = await Team.find({}, 'name memberCount openSeats maxSize leaderId').lean();
  const teamIds = new Set();
  for (const t of teams) {
    const id = String(t._id);
    teamIds.add(id);
    const r = byTeam.get(id) ?? { members: 0, leaders: [] };
    const where = `team ${t.name} (${id})`;
    if (t.memberCount !== r.members) violations.push(`${where}: memberCount=${t.memberCount} but ${r.members} participants`);
    if (t.openSeats !== t.maxSize - t.memberCount) violations.push(`${where}: openSeats=${t.openSeats}, expected ${t.maxSize - t.memberCount}`);
    if (t.memberCount < 1 || t.memberCount > t.maxSize) violations.push(`${where}: memberCount ${t.memberCount} outside 1..${t.maxSize}`);
    if (r.leaders.length !== 1) violations.push(`${where}: ${r.leaders.length} leaders`);
    else if (String(r.leaders[0]) !== String(t.leaderId)) violations.push(`${where}: leaderId does not match leader participant`);
  }

  for (const r of roster) {
    if (!teamIds.has(String(r._id))) violations.push(`${r.members} participant(s) point to missing team ${r._id}`);
  }

  const dupes = await Participant.aggregate([
    { $group: { _id: { h: '$hackathonId', u: '$userId' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 10 },
  ]);
  for (const d of dupes) violations.push(`user ${d._id.u} has ${d.n} registrations in hackathon ${d._id.h}`);

  return { teams: teams.length, participantsInTeams: roster.reduce((s, r) => s + r.members, 0), violations };
}
