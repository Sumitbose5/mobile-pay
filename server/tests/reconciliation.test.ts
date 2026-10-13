import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { ledgerEntries, transactions, wallets } from '../src/db/schema/index.js';
import { reconcile } from '../src/modules/reconciliation/reconciliation.service.js';
import { closeRedis } from '../src/redis/client.js';
import { ensureSystemWallet, fund, newAdmin, newUser, send, type TestUser } from './helpers.js';

let a: TestUser, b: TestUser;
beforeAll(async () => {
  await ensureSystemWallet();
  [a, b] = [await newUser(), await newUser()];
  await fund(a, 500_000);
  for (let i = 0; i < 5; i++) expect((await send(a, b, 10_000 + i)).status).toBe(201);
  expect((await send(b, a, 99_999_999)).status).toBe(422); // a FAILED record that must have no ledger entries
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

// Scoped to the two user wallets: the shared test database's system wallet carries fixtures from schema tests.
const scoped = () => reconcile({ walletIds: [a.walletId, b.walletId] });
const failing = (r: Awaited<ReturnType<typeof scoped>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('reconciliation', () => {
  it('passes every invariant on healthy books', async () => {
    const report = await scoped();
    expect(report.scope).toBe('wallets');
    expect(failing(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['balance_matches_ledger', 'ledger_chain_unbroken', 'transactions_balanced', 'successful_transactions_match_ledger', 'unsuccessful_transactions_moved_no_money', 'no_negative_user_wallets', 'no_stuck_transactions']),
    );
  });

  it('detects a wallet balance that drifted from its ledger and names the wallet', async () => {
    await db.update(wallets).set({ balance: sql`${wallets.balance} + 1` }).where(eq(wallets.id, a.walletId));
    try {
      const report = await scoped();
      expect(failing(report)).toEqual(['balance_matches_ledger']);
      const check = report.checks.find((c) => c.name === 'balance_matches_ledger')!;
      expect(check.violations[0]).toMatchObject({ wallet_id: a.walletId });
      expect(BigInt(check.violations[0]!.balance as string) - BigInt(check.violations[0]!.ledger_net as string)).toBe(1n);
    } finally {
      await db.update(wallets).set({ balance: sql`${wallets.balance} - 1` }).where(eq(wallets.id, a.walletId));
    }
    expect((await scoped()).ok).toBe(true);
  });

  it('detects a SUCCESS transaction that has no ledger entries', async () => {
    const [ghost] = await db
      .insert(transactions)
      .values({ publicId: 'TXN_GHOST0000001', type: 'TRANSFER', status: 'SUCCESS', amount: 1_234n, senderWalletId: a.walletId, receiverWalletId: b.walletId, completedAt: new Date() })
      .returning();
    try {
      const report = await scoped();
      expect(failing(report)).toEqual(['successful_transactions_match_ledger']);
      expect(report.checks.find((c) => c.name === 'successful_transactions_match_ledger')!.violations[0]).toMatchObject({ public_id: 'TXN_GHOST0000001', ledger_entries: 0 });
    } finally {
      await db.delete(transactions).where(eq(transactions.id, ghost!.id));
    }
  });

  it('detects a transaction stuck in flight', async () => {
    const [stuck] = await db
      .insert(transactions)
      .values({ publicId: 'TXN_STUCK0000001', type: 'TRANSFER', status: 'PROCESSING', amount: 500n, senderWalletId: a.walletId, receiverWalletId: b.walletId, createdAt: new Date(Date.now() - 60 * 60_000) })
      .returning();
    try {
      expect(failing(await scoped())).toEqual(['no_stuck_transactions']);
    } finally {
      await db.delete(transactions).where(eq(transactions.id, stuck!.id));
    }
  });

  it('detects a broken ledger chain (tampering with the append-only table)', async () => {
    const [entry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, b.walletId)).orderBy(sql`id desc`).limit(1);
    await db.execute(sql`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only`);
    try {
      // Shift one entry's before/after together so its own arithmetic still holds but the chain does not.
      await db.update(ledgerEntries).set({ balanceBefore: sql`${ledgerEntries.balanceBefore} + 7`, balanceAfter: sql`${ledgerEntries.balanceAfter} + 7` }).where(eq(ledgerEntries.id, entry!.id));
      const report = await scoped();
      expect(failing(report)).toContain('ledger_chain_unbroken');
      expect(report.checks.find((c) => c.name === 'ledger_chain_unbroken')!.violations[0]).toMatchObject({ wallet_id: b.walletId });
    } finally {
      await db.update(ledgerEntries).set({ balanceBefore: sql`${ledgerEntries.balanceBefore} - 7`, balanceAfter: sql`${ledgerEntries.balanceAfter} - 7` }).where(eq(ledgerEntries.id, entry!.id));
      await db.execute(sql`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only`);
    }
    expect((await scoped()).ok).toBe(true);
  });

  it('an empty scope checks nothing instead of everything', async () => {
    const report = await reconcile({ walletIds: [] });
    expect(report.ok).toBe(true);
  });
});

describe('reconciliation endpoints', () => {
  it('lets an admin run the full-system check and read the stored report; users are refused', async () => {
    const admin = await newAdmin();
    const user = await newUser();
    expect((await user.b.post('/api/v1/admin/reconciliation/run')).status).toBe(403);
    expect((await user.b.get('/api/v1/admin/reconciliation')).status).toBe(403);

    const run = await admin.b.post('/api/v1/admin/reconciliation/run');
    expect(run.status).toBe(200);
    const report = run.body.data.report;
    expect(report.scope).toBe('full');
    expect(report.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['money_is_conserved', 'ledger_starts_from_zero']));
    // (The shared test database holds fixtures inserted directly by schema tests, so a full run may report them.)
    const latest = await admin.b.get('/api/v1/admin/reconciliation');
    expect(latest.body.data.report.ranAt).toBe(report.ranAt);
  });
});
