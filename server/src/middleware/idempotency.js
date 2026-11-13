/**
 * Idempotency-Key support for unsafe (POST/PATCH/DELETE) requests.
 *
 * The client generates a random key per user ACTION (not per HTTP attempt) and re-sends the same
 * key on retries (double click, flaky network, timeout + retry).
 *
 *   1st request  -> we INSERT {userId, key} (unique index) BEFORE doing the work, state=in_progress
 *   retry while the first is still running -> insert fails (duplicate) -> 409 REQUEST_IN_PROGRESS
 *   retry after it finished                -> we replay the stored status + body; work is NOT redone
 *
 * Server errors (5xx) delete the key, so a retry can genuinely try again.
 * A key stuck "in_progress" for > 60 s (process crashed mid-request) is treated as stale and reclaimed.
 *
 * This is the first line of defence. The second is the data model itself: a person can only ever hold
 * one Participant.teamId, so even without a key a retry cannot join twice.
 */
import { IdempotencyKey } from '../models/index.js';
import { badRequest, conflict, isDuplicateKey } from '../lib/errors.js';

const STALE_MS = Number(process.env.IDEMPOTENCY_STALE_MS ?? 60_000);
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,100}$/;

export function idempotency({ required = false } = {}) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key) return required ? next(badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required')) : next();
    if (!KEY_RE.test(key)) return next(badRequest('INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key'));

    const route = `${req.method} ${req.baseUrl}${req.path}`;
    try {
      await IdempotencyKey.create({ userId: req.userId, key, route });
    } catch (err) {
      if (!isDuplicateKey(err)) return next(err);
      const existing = await IdempotencyKey.findOne({ userId: req.userId, key }).lean();
      if (!existing) return next(conflict('REQUEST_IN_PROGRESS', 'Please retry'));
      if (existing.route !== route) {
        return next(badRequest('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request'));
      }
      if (existing.state === 'done') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.statusCode).json(existing.body);
      }
      if (Date.now() - new Date(existing.createdAt).getTime() < STALE_MS) {
        return next(conflict('REQUEST_IN_PROGRESS', 'The original request is still being processed'));
      }
      // Stale: reclaim atomically (only one retry can win this conditional update).
      const reclaimed = await IdempotencyKey.findOneAndUpdate(
        { _id: existing._id, state: 'in_progress', createdAt: existing.createdAt },
        { $set: { createdAt: new Date() } }
      );
      if (!reclaimed) return next(conflict('REQUEST_IN_PROGRESS', 'Please retry'));
    }

    // Capture the response so retries can replay it.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const save =
        status >= 500
          ? IdempotencyKey.deleteOne({ userId: req.userId, key })
          : IdempotencyKey.updateOne({ userId: req.userId, key }, { $set: { state: 'done', statusCode: status, body } });
      save.catch(() => {}).finally(() => originalJson(body));
      return res;
    };
    next();
  };
}
