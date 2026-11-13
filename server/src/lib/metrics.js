/**
 * Prometheus metrics (bonus). GET /metrics
 *
 * The interesting ones for this problem:
 *   http_request_duration_seconds{route,method,status}  -> p95 per endpoint (histogram)
 *   txn_attempts_total{outcome}                          -> committed / aborted transactions
 *   txn_retries_total                                    -> how many times MongoDB made us retry
 *                                                           because of a write conflict = live
 *                                                           count of races that were resolved safely
 *   api_errors_total{code}                               -> TEAM_FULL, ALREADY_IN_TEAM, ... per code
 *   socket_connections                                   -> currently connected WebSocket clients
 *
 * Optional METRICS_TOKEN env: if set, /metrics requires "Authorization: Bearer <token>".
 */
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

export const txnAttempts = new client.Counter({
  name: 'txn_attempts_total',
  help: 'MongoDB transactions by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

export const txnRetries = new client.Counter({
  name: 'txn_retries_total',
  help: 'Transaction bodies re-run after a write conflict (a race resolved safely)',
  registers: [registry],
});

export const apiErrors = new client.Counter({
  name: 'api_errors_total',
  help: 'API errors by code',
  labelNames: ['code'],
  registers: [registry],
});

export const socketConnections = new client.Gauge({
  name: 'socket_connections',
  help: 'Connected Socket.io clients',
  registers: [registry],
});

/** Express middleware: time every request, labelled by the matched route pattern (not the raw URL). */
export function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    // res.locals.routeBase survives error handling (Express resets req.baseUrl on the way to the error handler).
    const base = res.locals.routeBase ?? req.baseUrl;
    const route = req.route ? `${base}${req.route.path}` : req.path === '/health' ? '/health' : 'unmatched';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

export async function metricsHandler(req, res) {
  const token = process.env.METRICS_TOKEN;
  if (token && req.get('authorization') !== `Bearer ${token}`) return res.status(401).end();
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

/** Put first in every Router so the metrics label keeps the mount path (e.g. /api/teams) even on errors. */
export function tagRouteBase(req, res, next) {
  res.locals.routeBase = req.baseUrl;
  next();
}
