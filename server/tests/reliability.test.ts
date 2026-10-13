import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pool } from '../src/db/client.js';
import { withTransaction } from '../src/db/transaction.js';
import { ledgerEntries, transactions, wallets } from '../src/db/schema/index.js';
import { AppError } from '../src/lib/errors.js';
import { applyTransfer } from '../src/modules/wallet/ledger.js';
import { closeRedis } from '../src/redis/client.js';
import { assertLedgerConsistent, balanceOf, ensureSystemWallet, fund, newUser, send, type TestUser } from './helpers.js';

let systemWalletId = '';
beforeAll(async () => {
  systemWalletId = await ensureSystemWallet();
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

const pgError = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });
const countTxns = async (u: TestUser) => (await db.select().from(transactions).where(eq(transactions.senderWalletId, u.walletId))).length;

describe('withTransaction: bounded retry and fail-fast locking', () => {
  it('retries a real deadlock and lets both transactions finish', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const attempts = { one: 0, two: 0 };
    // Two transactions lock the same two rows in opposite order: a textbook deadlock.
    const lockBoth = (first: string, second: string, key: 'one' | 'two') =>
      withTransaction(
        async (tx) => {
          attempts[key]++;
          await tx.select().from(wallets).where(eq(wallets.id, first)).for('update');
          await tx.execute(sql`select pg_sleep(0.2)`);
          await tx.select().from(wallets).where(eq(wallets.id, second)).for('update');
          return key;
        },
        { lockTimeoutMs: 15_000 },
      );
    const results = await Promise.all([lockBoth(a.walletId, b.walletId, 'one'), lockBoth(b.walletId, a.walletId, 'two')]);
    expect(results.sort()).toEqual(['one', 'two']);
    expect(attempts.one + attempts.two).toBeGreaterThanOrEqual(3); // the deadlock victim ran again
  });

  it('gives up after the retry budget with SERVICE_BUSY', async () => {
    let attempts = 0;
    const err = await withTransaction(async () => { attempts++; throw pgError('40P01'); }, { retries: 2 }).catch((e) => e);
    expect(attempts).toBe(3);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('SERVICE_BUSY');
    expect(err.status).toBe(503);
  });

  it('retries serialization failures but never retries business errors', async () => {
    let n = 0;
    expect(await withTransaction(async () => { if (++n < 3) throw pgError('40001'); return 'ok'; })).toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    const e = await withTransaction(async () => { m++; throw new AppError('INSUFFICIENT_BALANCE', 'no'); }).catch((x) => x);
    expect(e.code).toBe('INSUFFICIENT_BALANCE');
    expect(m).toBe(1);
  });

  it('answers 503 quickly when a wallet lock is held, changes nothing, and the same key works afterwards', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockAcquired = new Promise<void>((r) => (locked = r));
    // Another process holds the sender's wallet row lock (e.g. a stuck admin action).
    const holder = db.transaction(async (tx) => {
      await tx.select().from(wallets).where(eq(wallets.id, a.walletId)).for('update');
      locked();
      await held;
    });
    await lockAcquired;

    const key = randomUUID();
    const started = Date.now();
    const blocked = await send(a, b, 10_000, {}, key);
    expect(Date.now() - started).toBeLessThan(5_000); // failed fast at the 1.5 s test lock timeout, did not hang
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('SERVICE_BUSY');
    release();
    await holder;

    expect(await balanceOf(a.walletId)).toBe(100_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);
    const retried = await send(a, b, 10_000, {}, key); // 5xx is not remembered, so the key is reusable
    expect(retried.status).toBe(201);
    expect(await balanceOf(b.walletId)).toBe(10_000n);
  });
});

describe('failure injection: money is all-or-nothing', () => {
  it('rolls back every write if anything fails after the money has moved', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const before = await countTxns(a);
    await expect(
      db.transaction(async (tx) => {
        await applyTransfer(tx, { type: 'TRANSFER', senderWalletId: a.walletId, receiverWalletId: b.walletId, amount: 40_000n, initiatedBy: a.userId });
        throw new Error('process crashed right after the transfer was written');
      }),
    ).rejects.toThrow('process crashed');
    expect(await balanceOf(a.walletId)).toBe(100_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);
    expect(await countTxns(a)).toBe(before);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, b.walletId))).toHaveLength(0);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('loses nothing and invents nothing when the database connection is killed mid-transfer', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const before = await countTxns(a);
    const killer = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await expect(
        db.transaction(async (tx) => {
          await applyTransfer(tx, { type: 'TRANSFER', senderWalletId: a.walletId, receiverWalletId: b.walletId, amount: 40_000n, initiatedBy: a.userId });
          const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number };
          await killer.query('select pg_terminate_backend($1)', [pid.pid]); // the connection dies before COMMIT
          await tx.execute(sql`select 1`);
        }),
      ).rejects.toThrow();
    } finally {
      await killer.end();
    }
    expect(await balanceOf(a.walletId)).toBe(100_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);
    expect(await countTxns(a)).toBe(before);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
    expect((await pool.query('select 1 as ok')).rows[0].ok).toBe(1); // the pool recovers
  });

  it('the database itself refuses a one-sided ledger even if application code is wrong', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    await expect(
      db.transaction(async (tx) => {
        const [t] = await tx
          .insert(transactions)
          .values({ publicId: `TXN_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`, type: 'TRANSFER', status: 'PROCESSING', amount: 5_000n, senderWalletId: a.walletId, receiverWalletId: b.walletId })
          .returning();
        // Debit only: money would vanish. The deferred balance trigger rejects it at COMMIT.
        await tx.insert(ledgerEntries).values({ transactionId: t!.id, walletId: a.walletId, type: 'DEBIT', amount: 5_000n, balanceBefore: 100_000n, balanceAfter: 95_000n });
      }),
    ).rejects.toThrow();
    expect(await db.select().from(ledgerEntries).where(inArray(ledgerEntries.walletId, [a.walletId])).then((r) => r.filter((e) => e.type === 'DEBIT'))).toHaveLength(0);
  });
});
