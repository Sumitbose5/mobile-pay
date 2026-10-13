import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { newTransactionPublicId } from '../src/lib/ids.js';
import {
  auditLogs,
  idempotencyKeys,
  ledgerEntries,
  transactions,
  users,
  wallets,
} from '../src/db/schema/index.js';

/**
 * Proves the database itself enforces the financial guarantees, independent of application code.
 * Requires a migrated database (npm run db:migrate).
 */
let userA: string;
let walletA: string;
let walletB: string;

const uid = () => Math.random().toString(36).slice(2, 10);

async function makeUser(label: string) {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${label}-${uid()}@test.local`, passwordHash: 'x', status: 'ACTIVE' })
    .returning();
  const [w] = await db.insert(wallets).values({ userId: u!.id, balance: 100_000n }).returning();
  return { userId: u!.id, walletId: w!.id };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    // drizzle wraps the pg error in `cause`
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? 'unknown';
  }
};

beforeAll(async () => {
  ({ userId: userA, walletId: walletA } = await makeUser('alice'));
  ({ walletId: walletB } = await makeUser('bob'));
});

afterAll(async () => {
  await closeDb();
});

const newTxn = (over: Partial<typeof transactions.$inferInsert> = {}) => ({
  publicId: newTransactionPublicId(),
  type: 'TRANSFER' as const,
  amount: 500n,
  senderWalletId: walletA,
  receiverWalletId: walletB,
  initiatedBy: userA,
  ...over,
});

describe('wallet constraints', () => {
  it('rejects a negative balance (CHECK)', async () => {
    expect(await code(db.update(wallets).set({ balance: -1n }).where(eq(wallets.id, walletA)))).toBe('23514');
  });

  it('allows only one wallet per user (UNIQUE)', async () => {
    expect(await code(db.insert(wallets).values({ userId: userA }))).toBe('23505');
  });

  it('allows only one system wallet', async () => {
    await db.insert(wallets).values({ isSystem: true, userId: null }).onConflictDoNothing();
    expect(await code(db.insert(wallets).values({ isSystem: true, userId: null }))).toBe('23505');
  });

  it('only the system wallet may be negative', async () => {
    const [sys] = await db.select().from(wallets).where(eq(wallets.isSystem, true));
    expect(await code(db.update(wallets).set({ balance: -500n }).where(eq(wallets.id, sys!.id)))).toBeNull();
    await db.update(wallets).set({ balance: 0n }).where(eq(wallets.id, sys!.id));
  });
});

describe('transaction constraints', () => {
  it('rejects zero or negative amounts', async () => {
    expect(await code(db.insert(transactions).values(newTxn({ amount: 0n })))).toBe('23514');
  });

  it('rejects sending to yourself', async () => {
    expect(await code(db.insert(transactions).values(newTxn({ receiverWalletId: walletA })))).toBe('23514');
  });

  it('rejects a terminal state without completed_at', async () => {
    expect(await code(db.insert(transactions).values(newTxn({ status: 'SUCCESS' })))).toBe('23514');
  });

  it('enforces legal state transitions and immutable terminal states', async () => {
    const [t] = await db.insert(transactions).values(newTxn()).returning();
    // PENDING -> SUCCESS skips PROCESSING
    expect(await code(db.update(transactions).set({ status: 'SUCCESS', completedAt: new Date() }).where(eq(transactions.id, t!.id)))).toBe('23514');
    await db.update(transactions).set({ status: 'PROCESSING' }).where(eq(transactions.id, t!.id));
    await db.update(transactions).set({ status: 'SUCCESS', completedAt: new Date() }).where(eq(transactions.id, t!.id));
    // terminal
    expect(await code(db.update(transactions).set({ status: 'FAILED' }).where(eq(transactions.id, t!.id)))).toBe('23514');
  });

  it('forbids changing the amount of an existing transaction', async () => {
    const [t] = await db.insert(transactions).values(newTxn()).returning();
    expect(await code(db.update(transactions).set({ amount: 999n }).where(eq(transactions.id, t!.id)))).toBe('23514');
  });
});

describe('ledger guarantees', () => {
  it('rejects entries whose balance math is wrong', async () => {
    const [t] = await db.insert(transactions).values(newTxn()).returning();
    expect(
      await code(
        db.insert(ledgerEntries).values({ transactionId: t!.id, walletId: walletA, type: 'DEBIT', amount: 500n, balanceBefore: 1000n, balanceAfter: 1000n }),
      ),
    ).toBe('23514');
  });

  it('rejects an unbalanced transaction at commit (deferred trigger)', async () => {
    const [t] = await db.insert(transactions).values(newTxn()).returning();
    const result = await code(
      db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({ transactionId: t!.id, walletId: walletA, type: 'DEBIT', amount: 500n, balanceBefore: 1000n, balanceAfter: 500n });
      }),
    );
    expect(result).toBe('23000');
  });

  it('accepts a balanced debit + credit pair', async () => {
    const [t] = await db.insert(transactions).values(newTxn()).returning();
    await db.transaction(async (tx) => {
      await tx.insert(ledgerEntries).values([
        { transactionId: t!.id, walletId: walletA, type: 'DEBIT', amount: 500n, balanceBefore: 1000n, balanceAfter: 500n },
        { transactionId: t!.id, walletId: walletB, type: 'CREDIT', amount: 500n, balanceBefore: 0n, balanceAfter: 500n },
      ]);
    });
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, t!.id));
    expect(rows).toHaveLength(2);
  });

  it('is append-only: UPDATE and DELETE are blocked', async () => {
    const [row] = await db.select().from(ledgerEntries).limit(1);
    expect(await code(db.update(ledgerEntries).set({ amount: 1n }).where(eq(ledgerEntries.id, row!.id)))).toBe('23000');
    expect(await code(db.delete(ledgerEntries).where(eq(ledgerEntries.id, row!.id)))).toBe('23000');
  });
});

describe('audit log and idempotency', () => {
  it('audit logs are append-only', async () => {
    const [a] = await db.insert(auditLogs).values({ userId: userA, action: 'TEST' }).returning();
    expect(await code(db.delete(auditLogs).where(eq(auditLogs.id, a!.id)))).toBe('23000');
  });

  it('rejects a duplicate idempotency key for the same user and endpoint', async () => {
    const row = {
      userId: userA,
      key: `k-${uid()}`,
      endpoint: 'POST /wallet/send',
      requestHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await db.insert(idempotencyKeys).values(row);
    expect(await code(db.insert(idempotencyKeys).values(row))).toBe('23505');
  });

  it('email is unique case-insensitively', async () => {
    const email = `Case-${uid()}@Test.local`;
    await db.insert(users).values({ name: 'c', email, passwordHash: 'x' });
    expect(await code(db.insert(users).values({ name: 'c2', email: email.toLowerCase(), passwordHash: 'x' }))).toBe('23505');
  });
});

describe('row locking', () => {
  it('FOR UPDATE makes a concurrent transaction wait, so two spends cannot both succeed', async () => {
    await db.update(wallets).set({ balance: 1000n }).where(eq(wallets.id, walletA));

    const spend = () =>
      db.transaction(async (tx) => {
        const [w] = await tx.select().from(wallets).where(eq(wallets.id, walletA)).for('update');
        await new Promise((r) => setTimeout(r, 150)); // widen the race window
        if (w!.balance < 1000n) return 'insufficient';
        await tx.update(wallets).set({ balance: sql`${wallets.balance} - 1000` }).where(eq(wallets.id, walletA));
        return 'ok';
      });

    const results = await Promise.all([spend(), spend()]);
    expect(results.sort()).toEqual(['insufficient', 'ok']);
    const [final] = await db.select().from(wallets).where(eq(wallets.id, walletA));
    expect(final!.balance).toBe(0n);
  });
});
