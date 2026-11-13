import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

// PERFORMANCE: given a plain string secret, jsonwebtoken first tries to parse it as a PUBLIC key
// (crypto.createPublicKey), fails, then builds a secret key — on EVERY request. A CPU profile showed
// that was ~50% of the board endpoint's CPU time. Building the KeyObject once removes it.
const SECRET_KEY = crypto.createSecretKey(Buffer.from(config.jwtSecret, 'utf8'));
// SECURITY: pin the algorithm so a token can't pick its own (prevents "alg: none"/alg-confusion attacks).
const ALGORITHMS = ['HS256'];

export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, SECRET_KEY, { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' });
}

export function verifyToken(token) {
  const payload = jwt.verify(token, SECRET_KEY, { algorithms: ALGORITHMS });
  if (!mongoose.isValidObjectId(payload.sub)) throw new Error('bad subject');
  return new mongoose.Types.ObjectId(payload.sub);
}

/** Requires "Authorization: Bearer <jwt>". Sets req.userId (ObjectId). */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    req.userId = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}
