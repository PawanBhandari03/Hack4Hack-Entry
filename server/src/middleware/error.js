import { HttpError } from '../lib/errors.js';
import { apiErrors } from '../lib/metrics.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    apiErrors.inc({ code: err.code });
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  apiErrors.inc({ code: 'INTERNAL' });
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
