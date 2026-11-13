import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ------------------------------------------------------------------ */
/* Hackathon: holds the team rules (min/max size).                     */
/* ------------------------------------------------------------------ */
const hackathonSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    minTeamSize: { type: Number, required: true, min: 1 },
    maxTeamSize: { type: Number, required: true, min: 1 },
    teamFormationClosesAt: { type: Date },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* User: global account. utcOffsetMinutes is derived from timezone so   */
/* the suggestion engine doesn't have to call Intl for 10k users.       */
/* ------------------------------------------------------------------ */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    skills: { type: [String], default: [] },
    timezone: { type: String, default: 'UTC' },
    utcOffsetMinutes: { type: Number, default: 0 },
    bio: { type: String, default: '' },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* Participant: a user's registration in ONE hackathon.                 */
/* teamId === null  -> not in a team.                                   */
/* "One team per person per hackathon" is enforced by:                  */
/*   1. unique index {hackathonId, userId} (one row per person), and    */
/*   2. joins only succeed with a conditional update {teamId: null}.    */
/* name/skills/timezone are denormalised copies for a fast board.       */
/* ------------------------------------------------------------------ */
const participantSchema = new Schema(
  {
    hackathonId: { type: ObjectId, ref: 'Hackathon', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    skills: { type: [String], default: [] },
    timezone: { type: String, default: 'UTC' },
    utcOffsetMinutes: { type: Number, default: 0 },
    bio: { type: String, default: '' },
    teamId: { type: ObjectId, ref: 'Team', default: null },
    role: { type: String, enum: ['leader', 'member', null], default: null },
    joinedTeamAt: { type: Date, default: null },
    lookingForTeam: { type: Boolean, default: true },
  },
  { timestamps: true }
);
participantSchema.index({ hackathonId: 1, userId: 1 }, { unique: true });
// Team roster + "oldest member becomes leader" lookup.
participantSchema.index({ teamId: 1, joinedTeamAt: 1 });
// "People looking for a team" board (Equality, Equality, Equality, Sort).
participantSchema.index({ hackathonId: 1, teamId: 1, lookingForTeam: 1, updatedAt: -1 });
// Suggestion candidates by skill.
participantSchema.index({ hackathonId: 1, teamId: 1, skills: 1 });

/* ------------------------------------------------------------------ */
/* Team. openSeats = maxSize - memberCount, stored explicitly so that   */
/* "take a seat" is ONE atomic conditional update: {openSeats: {$gt:0}} */
/* ------------------------------------------------------------------ */
const teamSchema = new Schema(
  {
    hackathonId: { type: ObjectId, ref: 'Hackathon', required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true }, // lower-cased, for unique names per hackathon
    description: { type: String, default: '' },
    skillsWanted: { type: [String], default: [] },
    leaderId: { type: ObjectId, ref: 'User', required: true },
    memberCount: { type: Number, required: true, min: 0 },
    openSeats: { type: Number, required: true, min: 0 },
    minSize: { type: Number, required: true },
    maxSize: { type: Number, required: true },
    lookingForMembers: { type: Boolean, default: true },
  },
  { timestamps: true }
);
teamSchema.index({ hackathonId: 1, nameKey: 1 }, { unique: true });
// Board query: equality on hackathon + flag, sort by updatedAt, range on openSeats (ESR rule).
teamSchema.index({ hackathonId: 1, lookingForMembers: 1, updatedAt: -1, openSeats: 1 });

/* ------------------------------------------------------------------ */
/* Invite codes: only the SHA-256 hash is stored; plaintext is shown    */
/* once to the leader. A DB leak can't be used to join teams.           */
/* ------------------------------------------------------------------ */
const inviteSchema = new Schema(
  {
    hackathonId: { type: ObjectId, required: true },
    teamId: { type: ObjectId, ref: 'Team', required: true },
    codeHash: { type: String, required: true, unique: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    uses: { type: Number, default: 0 }, // incremented in the join transaction -> conflicts with a concurrent revoke
  },
  { timestamps: true }
);
inviteSchema.index({ teamId: 1, revokedAt: 1 });

/* ------------------------------------------------------------------ */
/* Join requests. Partial unique index: at most ONE pending request per */
/* (team, user) — double clicks can't create duplicates.                */
/* ------------------------------------------------------------------ */
const joinRequestSchema = new Schema(
  {
    hackathonId: { type: ObjectId, required: true },
    teamId: { type: ObjectId, ref: 'Team', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    userSkills: { type: [String], default: [] },
    teamName: { type: String, required: true },
    message: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'cancelled'],
      default: 'pending',
    },
    decidedBy: { type: ObjectId, default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
joinRequestSchema.index(
  { teamId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
joinRequestSchema.index({ teamId: 1, status: 1, createdAt: -1 });
joinRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });

/* ------------------------------------------------------------------ */
/* Audit log: who did what, when. Written in the SAME transaction as    */
/* the change, so the log can never disagree with the data.             */
/* ------------------------------------------------------------------ */
const auditLogSchema = new Schema(
  {
    hackathonId: { type: ObjectId, required: true },
    teamId: { type: ObjectId, default: null },
    actorId: { type: ObjectId, required: true },
    action: { type: String, required: true },
    targetUserId: { type: ObjectId, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditLogSchema.index({ teamId: 1, createdAt: -1 });
auditLogSchema.index({ hackathonId: 1, createdAt: -1 });

/* ------------------------------------------------------------------ */
/* Idempotency keys: unique per (user, key). Expire after 24h (TTL).    */
/* ------------------------------------------------------------------ */
const idempotencyKeySchema = new Schema({
  userId: { type: ObjectId, required: true },
  key: { type: String, required: true },
  route: { type: String, required: true },
  state: { type: String, enum: ['in_progress', 'done'], default: 'in_progress' },
  statusCode: { type: Number },
  body: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
});
idempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true });

export const Hackathon = model('Hackathon', hackathonSchema);
export const User = model('User', userSchema);
export const Participant = model('Participant', participantSchema);
export const Team = model('Team', teamSchema);
export const Invite = model('Invite', inviteSchema);
export const JoinRequest = model('JoinRequest', joinRequestSchema);
export const AuditLog = model('AuditLog', auditLogSchema);
export const IdempotencyKey = model('IdempotencyKey', idempotencyKeySchema);

export const allModels = [Hackathon, User, Participant, Team, Invite, JoinRequest, AuditLog, IdempotencyKey];

/** Build every index before serving traffic (the race test depends on unique indexes existing). */
export async function syncAllIndexes() {
  for (const m of allModels) {
    await m.createCollection().catch(() => {});
    await m.syncIndexes();
  }
}
