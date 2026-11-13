import mongoose from 'mongoose';
import { publish } from './realtime.js';
import { txnAttempts, txnRetries } from './metrics.js';
import { HttpError } from './errors.js';

const tryAgain = () => {
  const e = new HttpError(503, 'TRY_AGAIN', 'The team is busy right now, please retry in a moment');
  e.retryAfterSec = 2;
  return e;
};

// Give up retrying after this long (configurable so tests don't wait 15 s).
const maxTxnTimeMs = () => Number(process.env.TXN_MAX_RETRY_MS ?? 15_000);
const TXN_OPTIONS = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasLabel = (err, label) => typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel(label);

/** "Full jitter" exponential backoff: random 0..min(100, 4·2^attempt) ms. */
const backoff = (attempt) => Math.random() * Math.min(100, 4 * 2 ** attempt);

/**
 * Run `work(session, events)` inside a MongoDB transaction, retrying on write conflicts.
 *
 * WHY OUR OWN LOOP instead of session.withTransaction():
 *   withTransaction() retries a WriteConflict IMMEDIATELY. When 50 requests race for one seat, the 49
 *   losers spin in a tight loop against the same document while the winner is still committing.
 *   Measured on Atlas M0: 1,010 retries and ~23 s for a 50-way race. Waiting a small RANDOM time
 *   between attempts (exponential backoff with jitter) lets the winner commit first; the losers then
 *   see openSeats = 0 and stop. Same correctness, a fraction of the work.
 *
 * Semantics:
 *   - TransientTransactionError (e.g. WriteConflict)       -> abort, back off, re-run `work` on fresh data
 *   - UnknownTransactionCommitResult on commit (network)    -> retry the COMMIT only (safe: commit is idempotent)
 *   - any other error (e.g. our HttpError TEAM_FULL)        -> abort (all writes rolled back) and rethrow
 *   - `events` is reset on every attempt and published only after a successful commit.
 */
export async function runTxn(work) {
  const session = await mongoose.startSession();
  const started = Date.now();
  let events = [];
  let result;
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) txnRetries.inc(); // a concurrent writer beat us: retry with fresh data
      events = [];
      session.startTransaction(TXN_OPTIONS);
      try {
        result = await work(session, events);
        await commitWithRetry(session, started);
        break;
      } catch (err) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => {});
        if (hasLabel(err, 'TransientTransactionError')) {
          if (Date.now() - started < maxTxnTimeMs()) {
            await sleep(backoff(attempt));
            continue;
          }
          // Still conflicting after 15 s — e.g. a crashed server left a transaction open on this team
          // (Atlas aborts orphans after transactionLifetimeLimitSeconds = 60 s). Nothing was written;
          // tell the client to retry shortly instead of returning a generic 500.
          throw tryAgain();
        }
        throw err;
      }
    }
    txnAttempts.inc({ outcome: 'committed' });
  } catch (err) {
    txnAttempts.inc({ outcome: 'aborted' });
    throw err;
  } finally {
    await session.endSession();
  }
  publish(events);
  return result;
}

async function commitWithRetry(session, started) {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      if (hasLabel(err, 'UnknownTransactionCommitResult')) {
        if (Date.now() - started < maxTxnTimeMs()) {
          await sleep(backoff(attempt));
          continue;
        }
        // We genuinely don't know if it committed. 503 + the client's SAME Idempotency-Key on retry is safe:
        // if it did commit, the data model rejects a second join (ALREADY_IN_TEAM).
        throw tryAgain();
      }
      throw err; // TransientTransactionError here bubbles up and re-runs the whole transaction
    }
  }
}
