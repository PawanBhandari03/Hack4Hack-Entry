import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Start ONE in-memory MongoDB *replica set* for the whole test run.
 * It must be a replica set (not a standalone mongod) because transactions — and therefore
 * our race-proofing — only work on replica sets. Tests run against the same engine as Atlas.
 */
let replSet;

export async function setup({ provide }) {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // A crashed client leaves its open transaction behind until this limit (Atlas default: 60 s).
    // Shortened so the chaos test doesn't wait a full minute.
    instanceOpts: [{ args: ['--setParameter', 'transactionLifetimeLimitSeconds=5'] }],
  });
  provide('mongoUri', replSet.getUri());
}

export async function teardown() {
  await replSet?.stop();
}
