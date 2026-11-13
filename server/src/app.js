import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import authRouter from './routes/auth.js';
import hackathonsRouter from './routes/hackathons.js';
import { teamsRouter, invitesRouter, requestsRouter } from './routes/teams.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { metricsMiddleware, metricsHandler } from './lib/metrics.js';

export function createApp() {
  const app = express();
  // Behind Render's proxy: trust ONE hop so req.ip is the real client IP (rate limits per user, not per proxy).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(metricsMiddleware);
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigins, credentials: false }));
  app.use(express.json({ limit: '20kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/metrics', metricsHandler);

  app.use('/api/auth', authRouter);
  app.use('/api/hackathons', hackathonsRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/invites', invitesRouter);
  app.use('/api/requests', requestsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
