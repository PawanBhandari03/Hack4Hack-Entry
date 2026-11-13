import 'dotenv/config';

const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${name}`);
  return value;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI, // optional in tests (memory server injects it)
  jwtSecret: required('JWT_SECRET', process.env.NODE_ENV === 'test' ? 'test-secret' : undefined),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  inviteCodeTtlHours: Number(process.env.INVITE_CODE_TTL_HOURS ?? 48),
  // Rate limits can be relaxed for load testing; never disabled in production.
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
};
