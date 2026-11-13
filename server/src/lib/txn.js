import mongoose from 'mongoose';
import { publish } from './realtime.js';

/**
 * Run `work(session, events)` inside a MongoDB transaction.
 *
 * - session.withTransaction() automatically RETRIES on TransientTransactionError,
 *   which is exactly what MongoDB raises when two transactions write the same document
 *   at the same time (a "write conflict"). The loser re-runs its work against fresh data.
 * - `events` is reset on every attempt and published only after a successful commit.
 * - Any HttpError thrown inside aborts the transaction (all writes rolled back) and is rethrown.
 */
export async function runTxn(work) {
  const session = await mongoose.startSession();
  let events = [];
  let result;
  try {
    await session.withTransaction(
      async () => {
        events = [];
        result = await work(session, events);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
    );
  } finally {
    await session.endSession();
  }
  publish(events);
  return result;
}
