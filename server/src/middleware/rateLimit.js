import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const handler = (_req, res) =>
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' } });

const make = (opts) =>
  config.rateLimitEnabled ? rateLimit({ standardHeaders: 'draft-7', legacyHeaders: false, handler, ...opts }) : (_q, _s, n) => n();

/**
 * Invite codes: 10 attempts per 15 min, keyed by USER (not IP), so one attacker can't rotate IPs,
 * and many students behind one college NAT don't block each other.
 * Combined with 50-bit codes this makes brute force hopeless.
 */
export const inviteLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `invite:${req.userId}`,
});

/** Login/register: 20 attempts per 15 min per IP (password guessing). */
export const authLimiter = make({ windowMs: 15 * 60 * 1000, limit: 20 });

/** Anti-spam: one user can't fire join requests at hundreds of teams. 30 per 15 min per user. */
export const joinRequestLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => `request:${req.userId}`,
});

/** Anti-spam: create/leave/create loops. 20 team creations per hour per user. */
export const createTeamLimiter = make({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `create:${req.userId}`,
});
