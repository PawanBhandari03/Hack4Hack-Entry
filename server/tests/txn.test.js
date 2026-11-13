import { describe, it, expect, afterEach } from 'vitest';
import { runTxn } from '../src/lib/txn.js';

const transient = () => {
  const e = new Error('WriteConflict');
  e.hasErrorLabel = (label) => label === 'TransientTransactionError';
  return e;
};

afterEach(() => {
  delete process.env.TXN_MAX_RETRY_MS;
});

describe('runTxn retry loop', () => {
  it('retries a transient write conflict and then succeeds', async () => {
    let calls = 0;
    const result = await runTxn(async () => {
      if (++calls < 3) throw transient();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up with a clean 503 TRY_AGAIN (+ Retry-After) if conflicts never clear', async () => {
    process.env.TXN_MAX_RETRY_MS = '150';
    const err = await runTxn(async () => {
      throw transient();
    }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.code).toBe('TRY_AGAIN');
    expect(err.retryAfterSec).toBe(2);
  });

  it('does not retry business errors (e.g. TEAM_FULL)', async () => {
    let calls = 0;
    const err = await runTxn(async () => {
      calls++;
      throw Object.assign(new Error('full'), { status: 409, code: 'TEAM_FULL' });
    }).catch((e) => e);
    expect(err.code).toBe('TEAM_FULL');
    expect(calls).toBe(1);
  });
});
