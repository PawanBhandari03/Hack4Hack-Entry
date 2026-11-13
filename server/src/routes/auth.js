import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User, Participant } from '../models/index.js';
import { validate, schemas } from '../middleware/validate.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { conflict, unauthorized, notFound, isDuplicateKey } from '../lib/errors.js';
import { utcOffsetMinutes } from '../lib/timezone.js';
import { tagRouteBase } from '../lib/metrics.js';
import { publish, rooms } from '../lib/realtime.js';
import { personSummary } from '../services/teamService.js';

const router = Router();
router.use(tagRouteBase);

const publicUser = (u) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  skills: u.skills,
  timezone: u.timezone,
  bio: u.bio,
});

// A real bcrypt hash of a random string: used so login takes the same time whether or not
// the email exists (prevents discovering registered emails by timing).
const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy-password', 10);

router.post('/register', authLimiter, validate({ body: schemas.register }), async (req, res) => {
  const { name, email, password, skills, timezone, bio } = req.body;
  try {
    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      skills,
      timezone,
      utcOffsetMinutes: utcOffsetMinutes(timezone),
      bio,
    });
    res.status(201).json({ token: signToken(user._id), user: publicUser(user) });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
});

router.post('/login', authLimiter, validate({ body: schemas.login }), async (req, res) => {
  const user = await User.findOne({ email: req.body.email }).select('+passwordHash');
  const ok = await bcrypt.compare(req.body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Wrong email or password');
  res.json({ token: signToken(user._id), user: publicUser(user) });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'User not found');
  res.json({ user: publicUser(user) });
});

router.patch('/me', requireAuth, validate({ body: schemas.updateProfile }), async (req, res) => {
  const patch = { ...req.body };
  if (patch.timezone) patch.utcOffsetMinutes = utcOffsetMinutes(patch.timezone);
  const user = await User.findByIdAndUpdate(req.userId, { $set: patch }, { returnDocument: 'after' }).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'User not found');
  // Keep the denormalised copies on Participant rows in sync (used by the board + suggestions).
  const { name, skills, timezone, utcOffsetMinutes: off, bio } = user;
  await Participant.updateMany({ userId: user._id }, { $set: { name, skills, timezone, utcOffsetMinutes: off, bio } });
  // Live: update this person's card on every board they appear on, and their team pages.
  const rows = await Participant.find({ userId: user._id }).lean();
  publish(
    rows.flatMap((p) => [
      { room: rooms.hackathon(p.hackathonId), event: 'board:person', payload: personSummary(p) },
      ...(p.teamId ? [{ room: rooms.team(p.teamId), event: 'team:updated', payload: { teamId: String(p.teamId) } }] : []),
    ])
  );
  res.json({ user: publicUser(user) });
});

export default router;
