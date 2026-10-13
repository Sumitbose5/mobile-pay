import { randomUUID } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { ledgerEntries, outboxEvents, systemSettings, transactions, wallets } from '../src/db/schema/index.js';
import { clearSettingsCache } from '../src/modules/settings/settings.service.js';
import { closeRedis, getRedis } from '../src/redis/client.js';
import { assertLedgerConsistent, balanceOf, ensureSystemWallet, fund, newUser, PIN, send } from './helpers.js';

let systemWalletId = '';
beforeAll(async () => {
  systemWalletId = await ensureSystemWallet();
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

async function withSetting<T>(key: string, value: number, fn: () => Promise<T>): Promise<T> {
  await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
  clearSettingsCache();
  try {
    return await fn();
  } finally {
    await db.delete(systemSettings).where(eq(systemSettings.key, key));
    clearSettingsCache();
  }
}

describe('send money', () => {
  it('moves money atomically with a SUCCESS transaction, two ledger entries and outbox events', async () => {
    const [a, b] = [await newUser({ name: 'Sumit' }), await newUser({ name: 'Rahul' })];
    await fund(a, 500_000);
    const res = await send(a, b, 100_000, { note: 'Dinner' });
    expect(res.status).toBe(201);
    expect(res.body.data.transaction).toMatchObject({ status: 'SUCCESS', amount: '100000', receiverName: 'Rahul', note: 'Dinner' });
    expect(await balanceOf(a.walletId)).toBe(400_000n);
    expect(await balanceOf(b.walletId)).toBe(100_000n);

    const [txn] = await db.select().from(transactions).where(eq(transactions.publicId, res.body.data.transaction.id));
    expect(txn).toMatchObject({ type: 'TRANSFER', status: 'SUCCESS', senderWalletId: a.walletId, receiverWalletId: b.walletId });
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, txn!.id));
    expect(entries.map((e) => `${e.type}:${e.amount}:${e.balanceBefore}->${e.balanceAfter}`).sort()).toEqual([
      'CREDIT:100000:0->100000',
      'DEBIT:100000:500000->400000',
    ]);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, txn!.id));
    expect(events.map((e) => e.eventType).sort()).toEqual(['MONEY_RECEIVED', 'MONEY_SENT']);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('rejects a wrong PIN without moving money, counts attempts, and never records a transfer', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const res = await send(a, b, 10_000, { pin: '1357' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_PIN');
    expect(await balanceOf(a.walletId)).toBe(100_000n);
    expect(await db.select().from(transactions).where(eq(transactions.senderWalletId, a.walletId))).toHaveLength(0);
    await getRedis().del(`pin:attempts:${a.userId}`);
  });

  it('lets the same Idempotency-Key be retried after a wrong PIN, then replays after success', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const key = randomUUID();
    expect((await send(a, b, 10_000, { pin: '1357' }, key)).status).toBe(401);
    const ok = await send(a, b, 10_000, {}, key);
    expect(ok.status).toBe(201);
    const replay = await send(a, b, 10_000, {}, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.transaction.id).toBe(ok.body.data.transaction.id);
    expect(await balanceOf(b.walletId)).toBe(10_000n); // one transfer, not two
    await getRedis().del(`pin:attempts:${a.userId}`);
  });

  it('fails with INSUFFICIENT_BALANCE, leaves balances alone, and keeps a FAILED record in history', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 5_000);
    const res = await send(a, b, 10_000);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(a.walletId)).toBe(5_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);
    const failed = await db.select().from(transactions).where(eq(transactions.status, 'FAILED'));
    const mine = failed.filter((t) => t.senderWalletId === a.walletId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ failureCode: 'INSUFFICIENT_BALANCE', amount: 10_000n });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, mine[0]!.id))).toHaveLength(0);
  });

  it('validates recipient, amount and PIN setup', async () => {
    const a = await newUser();
    const b = await newUser();
    await fund(a, 100_000);
    expect((await send(a, { email: 'nobody@test.local' }, 10_000)).status).toBe(404);
    expect((await send(a, a, 10_000)).body.error.code).toBe('VALIDATION_ERROR'); // self
    expect((await send(a, b, 0)).status).toBe(400);
    expect((await send(a, b, '12.5')).status).toBe(400);
    expect((await send(a, b, 50)).body.error.code).toBe('LIMIT_EXCEEDED'); // below minimum (Rs 1)
    expect((await send(a, b, 5_000_001)).body.error.code).toBe('LIMIT_EXCEEDED'); // above Rs 50,000
    const noPin = await newUser({ pin: false });
    expect((await send(noPin, b, 10_000)).body.error.code).toBe('PIN_NOT_SET');
    expect((await a.b.post('/api/v1/wallet/send', { receiverEmail: b.email, amount: 10_000, pin: PIN })).status).toBe(400); // no key
  });

  it('refuses frozen senders and frozen receivers', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    await db.update(wallets).set({ status: 'FROZEN' }).where(eq(wallets.id, b.walletId));
    const toFrozen = await send(a, b, 10_000);
    expect(toFrozen.body.error.code).toBe('RECEIVER_WALLET_FROZEN');
    await db.update(wallets).set({ status: 'ACTIVE' }).where(eq(wallets.id, b.walletId));
    await db.update(wallets).set({ status: 'FROZEN' }).where(eq(wallets.id, a.walletId));
    const fromFrozen = await send(a, b, 10_000);
    expect(fromFrozen.status).toBe(423);
    expect(fromFrozen.body.error.code).toBe('WALLET_FROZEN');
    expect(await balanceOf(a.walletId)).toBe(100_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);
  });

  it('enforces the recipient wallet cap', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    await withSetting('limits.max_wallet_balance', 50_000, async () => {
      expect((await send(a, b, 50_001)).body.error.code).toBe('LIMIT_EXCEEDED');
      expect((await send(a, b, 50_000)).status).toBe(201);
    });
  });
});

describe('concurrency: the headline guarantees', () => {
  it('lets only one of 10 parallel spends of the full balance succeed (no double spend)', async () => {
    const a = await newUser();
    const receivers = await Promise.all(Array.from({ length: 10 }, () => newUser()));
    await fund(a, 100_000); // Rs 1,000
    const results = await Promise.all(receivers.map((r) => send(a, r, 100_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_BALANCE')).toHaveLength(9);
    expect(await balanceOf(a.walletId)).toBe(0n);
    const received = (await Promise.all(receivers.map((r) => balanceOf(r.walletId)))).reduce((x, y) => x + y, 0n);
    expect(received).toBe(100_000n);
    await assertLedgerConsistent([a.walletId, systemWalletId, ...receivers.map((r) => r.walletId)]);
  });

  it('with 50 parallel sends of Rs 100 from Rs 1,000, exactly 10 succeed and the balance never goes negative', async () => {
    const a = await newUser();
    const b = await newUser();
    await fund(a, 100_000);
    const results = await Promise.all(Array.from({ length: 50 }, () => send(a, b, 10_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(40);
    expect(await balanceOf(a.walletId)).toBe(0n);
    expect(await balanceOf(b.walletId)).toBe(100_000n);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('does not deadlock when A->B and B->A transfers run at the same time, and conserves total money', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 1_000_000);
    await fund(b, 1_000_000);
    const batch = Array.from({ length: 20 }, (_, i) => [send(a, b, 1_000 + i), send(b, a, 2_000 + i)]).flat();
    const results = await Promise.all(batch);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await balanceOf(a.walletId)) + (await balanceOf(b.walletId))).toBe(2_000_000n);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('applies the daily limit under the wallet lock, so parallel sends cannot jointly exceed it', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 500_000);
    await withSetting('limits.daily_send', 25_000, async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => send(a, b, 10_000)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2); // 20,000 fits; a third would reach 30,000
      expect(results.filter((r) => r.body.error?.code === 'LIMIT_EXCEEDED')).toHaveLength(8);
    });
    expect(await balanceOf(b.walletId)).toBe(20_000n);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('retries with one Idempotency-Key fired in parallel produce one transfer', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => send(a, b, 10_000, {}, key)));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await balanceOf(b.walletId)).toBe(10_000n);
    const rows = await db.select().from(transactions).where(or(eq(transactions.senderWalletId, a.walletId)));
    expect(rows.filter((t) => t.type === 'TRANSFER' && t.status === 'SUCCESS')).toHaveLength(1);
  });
});
