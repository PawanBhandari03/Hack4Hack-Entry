import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function verifyToken(token) {
  const payload = jwt.verify(token, config.jwtSecret);
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
