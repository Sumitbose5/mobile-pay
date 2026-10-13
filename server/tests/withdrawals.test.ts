// Isolated queues and no simulated bank latency, so the payout worker can be observed in milliseconds.
process.env.QUEUE_PREFIX = `test-${Math.random().toString(36).slice(2, 8)}`;
process.env.PAYOUT_DELAY_MS = '0';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db } = await import('../src/db/client.js');
const { bankAccounts, ledgerEntries, notifications, outboxEvents, systemSettings, transactions, wallets } = await import('../src/db/schema/index.js');
const { dispatchOutbox } = await import('../src/jobs/outbox.js');
const { startBackgroundJobs } = await import('../src/jobs/workers.js');
const { reconcile } = await import('../src/modules/reconciliation/reconciliation.service.js');
const { clearSettingsCache } = await import('../src/modules/settings/settings.service.js');
const { processPayout } = await import('../src/modules/wallet/withdraw.service.js');
const { closeQueues, getQueue, QUEUES } = await import('../src/queues/queues.js');
const { closeRedis, getRedis } = await import('../src/redis/client.js');
const { assertLedgerConsistent, balanceOf, browser, ensureSystemWallet, fund, newUser, PIN, uniq } = await import('./helpers.js');
type TestUser = Awaited<ReturnType<typeof newUser>>;

let systemWalletId = '';
let jobs: { stop: () => Promise<void> };

async function waitFor<T>(fn: () => Promise<T | undefined | false | null>, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeAll(async () => {
  systemWalletId = await ensureSystemWallet();
  await db.update(outboxEvents).set({ status: 'PROCESSED' }).where(eq(outboxEvents.status, 'PENDING'));
  jobs = startBackgroundJobs({ outbox: false });
});
afterAll(async () => {
  await jobs.stop();
  for (const name of Object.values(QUEUES)) await getQueue(name).obliterate({ force: true }).catch(() => undefined);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

const upiBody = (extra: Record<string, unknown> = {}) => ({ holderName: 'Asha Rao', upiId: 'asha.rao@okbank', pin: PIN, ...extra });
async function addAccount(u: TestUser, extra: Record<string, unknown> = {}) {
  const res = await u.b.post('/api/v1/bank-accounts', upiBody(extra));
  expect(res.status).toBe(201);
  return res.body.data.bankAccount.id as string;
}
const withdraw = (u: TestUser, bankAccountId: string, amount: number | string, extra: Record<string, unknown> = {}, key: string = randomUUID()) =>
  u.b.post('/api/v1/wallet/withdraw', { bankAccountId, amount, pin: PIN, ...extra }, { 'idempotency-key': key });
const txnById = async (publicId: string) => (await db.select().from(transactions).where(eq(transactions.publicId, publicId)))[0]!;
const scopedReconcile = (...ids: string[]) => reconcile({ walletIds: ids });

describe('payout accounts', () => {
  it('stores only masked identifiers and validates the input', async () => {
    const u = await newUser();
    expect((await u.b.post('/api/v1/bank-accounts', { holderName: 'A B', pin: PIN })).status).toBe(400); // neither UPI nor account
    expect((await u.b.post('/api/v1/bank-accounts', upiBody({ accountNumber: '123456789012', ifsc: 'HDFC0001234' }))).status).toBe(400); // both
    expect((await u.b.post('/api/v1/bank-accounts', { holderName: 'A B', accountNumber: '123456789012', pin: PIN })).status).toBe(400); // no IFSC
    expect((await u.b.post('/api/v1/bank-accounts', { holderName: 'A B', accountNumber: '123456789012', ifsc: 'BAD', pin: PIN })).status).toBe(400);
    expect((await u.b.post('/api/v1/bank-accounts', upiBody({ upiId: 'nope' }))).status).toBe(400);
    expect((await u.b.post('/api/v1/bank-accounts', upiBody({ pin: '1357' }))).status).toBe(401);
    await getRedis().del(`pin:attempts:${u.userId}`);

    const upi = await u.b.post('/api/v1/bank-accounts', upiBody());
    expect(upi.body.data.bankAccount).toMatchObject({ upiIdMasked: 'as***@okbank', isVerified: true });
    const bank = await u.b.post('/api/v1/bank-accounts', { holderName: 'Asha Rao', accountNumber: '123456789012', ifsc: 'hdfc0001234', pin: PIN });
    expect(bank.body.data.bankAccount).toMatchObject({ accountLast4: '9012', ifsc: 'HDFC0001234', label: 'Bank account ••9012 (HDFC0001234)' });

    const rows = await db.select().from(bankAccounts).where(eq(bankAccounts.userId, u.userId));
    expect(JSON.stringify(rows)).not.toContain('123456789012'); // the full number is never stored
    expect(JSON.stringify(rows)).not.toContain('asha.rao@okbank');
    expect(JSON.stringify((await u.b.get('/api/v1/bank-accounts')).body)).not.toContain('asha.rao@okbank');
  });

  it('caps at 5, soft-deletes, and stays private', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await addAccount(a, { upiId: `user${i}x@okbank` }));
    expect((await a.b.post('/api/v1/bank-accounts', upiBody())).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await b.b.del(`/api/v1/bank-accounts/${ids[0]}`)).status).toBe(404);
    expect((await b.b.get('/api/v1/bank-accounts')).body.data.bankAccounts).toHaveLength(0);
    expect((await a.b.del(`/api/v1/bank-accounts/${ids[0]}`)).status).toBe(200);
    expect((await a.b.get('/api/v1/bank-accounts')).body.data.bankAccounts).toHaveLength(4);
    expect((await browser().get('/api/v1/bank-accounts')).status).toBe(401);
  });
});

describe('withdrawing', () => {
  it('holds the money immediately, then the payout worker completes it', async () => {
    const u = await newUser();
    await fund(u, 100_000);
    const acct = await addAccount(u);
    const res = await withdraw(u, acct, 30_000);
    expect(res.status).toBe(201);
    expect(res.body.data.transaction).toMatchObject({ status: 'PROCESSING', amount: '30000', destination: 'as***@okbank' });
    const id = res.body.data.transaction.id as string;

    // The funds left the wallet at once and sit in the platform clearing wallet while the bank is paid.
    expect(await balanceOf(u.walletId)).toBe(70_000n);
    const held = await txnById(id);
    expect(held).toMatchObject({ type: 'WITHDRAWAL', status: 'PROCESSING', senderWalletId: u.walletId, receiverWalletId: systemWalletId });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, held.id))).toHaveLength(2);
    const inFlight = (await u.b.get('/api/v1/transactions?direction=WITHDRAWN')).body.data.items[0];
    expect(inFlight).toMatchObject({ id, status: 'PROCESSING', direction: 'WITHDRAWN', signedAmount: '-30000' }); // already counted as money out

    await dispatchOutbox(); // enqueues the payout job
    await waitFor(async () => (await txnById(id)).status === 'SUCCESS');
    expect((await txnById(id)).completedAt).not.toBeNull();
    expect(await balanceOf(u.walletId)).toBe(70_000n);
    await waitFor(async () => {
      await dispatchOutbox();
      const titles = (await db.select().from(notifications).where(eq(notifications.userId, u.userId))).map((n) => n.title);
      return titles.includes('Withdrawal started') && titles.includes('Withdrawal completed');
    });
    expect((await scopedReconcile(u.walletId)).ok).toBe(true);
  });

  it('refunds automatically when the bank rejects the payout, through a linked reversal', async () => {
    const u = await newUser();
    await fund(u, 100_000);
    const acct = await addAccount(u, { holderName: 'Fail Test' }); // the simulated bank rejects accounts named "fail"
    const id = (await withdraw(u, acct, 40_000)).body.data.transaction.id as string;
    expect(await balanceOf(u.walletId)).toBe(60_000n);

    await dispatchOutbox();
    await waitFor(async () => (await txnById(id)).status === 'FAILED');
    expect(await balanceOf(u.walletId)).toBe(100_000n); // fully refunded
    const original = await txnById(id);
    expect(original).toMatchObject({ status: 'FAILED', failureCode: 'PAYOUT_REJECTED' });
    const refunds = await db.select().from(transactions).where(eq(transactions.reversalOfTransactionId, original.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ type: 'REVERSAL', status: 'SUCCESS', senderWalletId: systemWalletId, receiverWalletId: u.walletId, amount: 40_000n });

    const history = (await u.b.get('/api/v1/transactions?limit=10')).body.data.items as { id: string; type: string; status: string; signedAmount: string; counterparty: { name: string } | null }[];
    expect(history.find((t) => t.id === id)).toMatchObject({ status: 'FAILED', signedAmount: '0' }); // net zero
    expect(history.find((t) => t.type === 'REVERSAL')).toMatchObject({ signedAmount: '40000', counterparty: { name: 'CoinHub' } });

    await waitFor(async () => {
      await dispatchOutbox();
      return (await db.select().from(notifications).where(eq(notifications.userId, u.userId))).some((n) => n.title === 'Withdrawal failed, money returned');
    });
    // A failed-but-refunded withdrawal keeps its ledger entries, and reconciliation accepts exactly that case.
    expect((await scopedReconcile(u.walletId)).ok).toBe(true);
    await assertLedgerConsistent([u.walletId, systemWalletId]);
  });

  it('settles a payout at most once, however many times the job runs', async () => {
    const u = await newUser();
    await fund(u, 100_000);
    const ok = (await withdraw(u, await addAccount(u), 10_000)).body.data.transaction.id as string;
    const bad = (await withdraw(u, await addAccount(u, { holderName: 'Fail Again', upiId: 'other@okbank' }), 20_000)).body.data.transaction.id as string;
    const [okTxn, badTxn] = [await txnById(ok), await txnById(bad)];

    const first = await Promise.all([processPayout(okTxn.id), processPayout(okTxn.id), processPayout(badTxn.id), processPayout(badTxn.id)]);
    expect(first.filter((r) => r === 'SUCCESS')).toHaveLength(1);
    expect(first.filter((r) => r === 'FAILED')).toHaveLength(1);
    expect(first.filter((r) => r === 'SKIPPED')).toHaveLength(2);
    expect(await processPayout(badTxn.id)).toBe('SKIPPED');
    expect(await db.select().from(transactions).where(eq(transactions.reversalOfTransactionId, badTxn.id))).toHaveLength(1); // one refund
    expect(await balanceOf(u.walletId)).toBe(90_000n); // 100,000 - 10,000 paid out; the 20,000 came back
    await assertLedgerConsistent([u.walletId, systemWalletId]);
  });

  it('refuses insufficient funds, wrong PIN, frozen wallets and other peoples accounts', async () => {
    const [u, other] = [await newUser(), await newUser()];
    await fund(u, 20_000);
    const acct = await addAccount(u);
    const theirs = await addAccount(other);
    expect((await withdraw(u, acct, 50_000)).body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await withdraw(u, acct, 5_000, { pin: '1357' })).body.error.code).toBe('INVALID_PIN');
    await getRedis().del(`pin:attempts:${u.userId}`);
    expect((await withdraw(u, theirs, 5_000)).status).toBe(404);
    expect((await withdraw(u, acct, 0)).status).toBe(400);
    expect((await withdraw(u, acct, 50)).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await withdraw(u, acct, 5_000_001)).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await u.b.post('/api/v1/wallet/withdraw', { bankAccountId: acct, amount: 5_000, pin: PIN })).status).toBe(400); // no idempotency key
    await db.update(wallets).set({ status: 'FROZEN' }).where(eq(wallets.id, u.walletId));
    expect((await withdraw(u, acct, 5_000)).body.error.code).toBe('WALLET_FROZEN');
    expect(await balanceOf(u.walletId)).toBe(20_000n);
  });

  it('counts withdrawals that are still in flight against the daily limit', async () => {
    const u = await newUser();
    await fund(u, 500_000);
    const acct = await addAccount(u);
    await db.insert(systemSettings).values({ key: 'limits.daily_send', value: 25_000 }).onConflictDoUpdate({ target: systemSettings.key, set: { value: 25_000 } });
    clearSettingsCache();
    try {
      expect((await withdraw(u, acct, 20_000)).status).toBe(201); // PROCESSING, not yet paid out
      const over = await withdraw(u, acct, 10_000);
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe('LIMIT_EXCEEDED');
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, 'limits.daily_send'));
      clearSettingsCache();
    }
  });

  it('lets only one of 10 parallel full-balance withdrawals through, and one retry key creates one withdrawal', async () => {
    const u = await newUser();
    await fund(u, 100_000);
    const acct = await addAccount(u);
    const results = await Promise.all(Array.from({ length: 10 }, () => withdraw(u, acct, 100_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.error?.code === 'INSUFFICIENT_BALANCE')).toHaveLength(9);
    expect(await balanceOf(u.walletId)).toBe(0n);

    const v = await newUser();
    await fund(v, 100_000);
    const vAcct = await addAccount(v);
    const key = randomUUID();
    const retries = await Promise.all(Array.from({ length: 6 }, () => withdraw(v, vAcct, 10_000, {}, key)));
    for (const r of retries) expect([201, 409]).toContain(r.status);
    expect(await balanceOf(v.walletId)).toBe(90_000n);
    await assertLedgerConsistent([u.walletId, v.walletId, systemWalletId]);
  });
});

void uniq;
