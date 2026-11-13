import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Start ONE in-memory MongoDB *replica set* for the whole test run.
 * It must be a replica set (not a standalone mongod) because transactions — and therefore
 * our race-proofing — only work on replica sets. Tests run against the same engine as Atlas.
 */
let replSet;

export async function setup({ provide }) {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  provide('mongoUri', replSet.getUri());
}

export async function teardown() {
  await replSet?.stop();
}
