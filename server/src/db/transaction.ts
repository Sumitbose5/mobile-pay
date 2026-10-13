import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { db, type DbTx } from './client.js';

/** PostgreSQL error codes that mean "nothing is wrong with the request, the database asked us to try again". */
const DEADLOCK = '40P01';
const SERIALIZATION = '40001';
const LOCK_TIMEOUT = '55P03';
const RETRYABLE = new Set([DEADLOCK, SERIALIZATION]);

export const pgErrorCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

export interface TransactionOptions {
  /** Extra attempts after a deadlock or serialization failure (default 3). */
  retries?: number;
  lockTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (why: string) => new AppError('SERVICE_BUSY', 'The system is busy. Nothing was changed; please retry.', { why });

/**
 * Runs `fn` in a database transaction with the safety rails every money path needs:
 *  - a lock timeout, so a held lock produces a fast 503 instead of a hung request;
 *  - bounded retry with jittered backoff on deadlock / serialization failure (`fn` must therefore be
 *    safe to run again, i.e. do all its writes through `tx`);
 *  - anything else, including business errors, rolls back and propagates untouched.
 */
export async function withTransaction<T>(fn: (tx: DbTx) => Promise<T>, opts: TransactionOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const lockTimeout = Math.trunc(opts.lockTimeoutMs ?? env.LOCK_TIMEOUT_MS);

  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${lockTimeout}`));
        return fn(tx);
      });
    } catch (err) {
      const code = pgErrorCode(err);
      if (code === LOCK_TIMEOUT) throw busy('lock_timeout');
      if (code && RETRYABLE.has(code)) {
        if (attempt >= retries) throw busy(code === DEADLOCK ? 'deadlock' : 'serialization_failure');
        logger.warn({ code, attempt: attempt + 1 }, 'Retrying transaction after database conflict');
        await sleep(20 * 2 ** attempt + Math.random() * 20);
        continue;
      }
      throw err;
    }
  }
}
