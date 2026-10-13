import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema/index.js';

/**
 * Pooled TCP connection (Neon pooled string in production).
 * The money path needs interactive transactions (BEGIN ... SELECT FOR UPDATE ... COMMIT),
 * which the Neon HTTP driver does not support, so we use node-postgres over TCP.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000, // tolerate Neon cold starts
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
});

// Idle clients report errors on the pool; a client that is checked out (mid-transaction) reports on itself.
// Without this listener, a connection killed during a transaction (failover, restart, pg_terminate_backend)
// is an unhandled 'error' event and crashes the whole Node process. The query/transaction that was using the
// client still rejects normally, so the caller sees the failure and the transaction rolls back.
pool.on('error', (err) => logger.error({ err }, 'Unexpected Postgres pool error'));
pool.on('connect', (client) => {
  client.on('error', (err) => logger.error({ err }, 'Postgres client error'));
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
/** Transaction handle; repositories accept `Db | DbTx` so they can join a caller's transaction. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | DbTx;

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
