import { beforeAll, afterAll, beforeEach, inject } from 'vitest';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const { syncAllIndexes, allModels } = await import('../src/models/index.js');
const { clearBoardCache } = await import('../src/services/boardService.js');
const { clearHackathonCache } = await import('../src/services/teamService.js');

beforeAll(async () => {
  const uri = inject('mongoUri');
  // Each test file gets its own database so files can't affect each other.
  const dbName = `test_${Math.random().toString(36).slice(2, 10)}`;
  await mongoose.connect(uri, { dbName });
  await syncAllIndexes(); // unique indexes MUST exist before the race tests run
});

beforeEach(async () => {
  await Promise.all(allModels.map((m) => m.deleteMany({})));
  clearBoardCache();
  clearHackathonCache();
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
