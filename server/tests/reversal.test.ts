import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { auditLogs, outboxEvents, transactions, wallets } from '../src/db/schema/index.js';
import { closeRedis } from '../src/redis/client.js';
import { assertLedgerConsistent, balanceOf, ensureSystemWallet, fund, newAdmin, newUser, send, type TestUser } from './helpers.js';

let systemWalletId = '';
let admin: Awaited<ReturnType<typeof newAdmin>>;
beforeAll(async () => {
  systemWalletId = await ensureSystemWallet();
  admin = await newAdmin();
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

const reverse = (id: string, reason = 'Sent to the wrong person') => admin.b.post(`/api/v1/admin/transactions/${id}/reverse`, { reason });
async function transfer(from: TestUser, to: TestUser, amount = 100_000) {
  const res = await send(from, to, amount);
  expect(res.status).toBe(201);
  return res.body.data.transaction.id as string;
}

describe('admin reversal', () => {
  it('posts a linked reversal, restores both balances and leaves history intact', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 500_000);
    const id = await transfer(a, b);
    const res = await reverse(id);
    expect(res.status).toBe(201);
    expect(res.body.data.reversal).toMatchObject({ status: 'SUCCESS', amount: '100000', reversalOf: id });

    expect(await balanceOf(a.walletId)).toBe(500_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);

    const [original] = await db.select().from(transactions).where(eq(transactions.publicId, id));
    expect(original?.status).toBe('SUCCESS'); // never edited
    const [rev] = await db.select().from(transactions).where(eq(transactions.reversalOfTransactionId, original!.id));
    expect(rev).toMatchObject({ type: 'REVERSAL', status: 'SUCCESS', senderWalletId: b.walletId, receiverWalletId: a.walletId, initiatedBy: admin.userId });

    const detail = await a.b.get(`/api/v1/transactions/${id}`);
    expect(detail.body.data.transaction.reversedBy).toBe(rev!.publicId);
    const revDetail = await b.b.get(`/api/v1/transactions/${rev!.publicId}`);
    expect(revDetail.body.data.transaction).toMatchObject({ reversalOf: id, direction: 'SENT', type: 'REVERSAL' });

    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, rev!.id));
    expect(events.map((e) => e.eventType).sort()).toEqual(['REVERSAL_CREDITED', 'REVERSAL_DEBITED']);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entityId, original!.id));
    expect(logs.find((l) => l.action === 'TRANSACTION_REVERSED')).toMatchObject({ userId: admin.userId, severity: 'WARN' });
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('reverses a transfer at most once, even when 6 admins click at the same moment', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 300_000);
    const id = await transfer(a, b, 100_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => reverse(id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'DUPLICATE_TRANSACTION')).toHaveLength(5);
    expect(await balanceOf(a.walletId)).toBe(300_000n);
    expect(await balanceOf(b.walletId)).toBe(0n);
    await assertLedgerConsistent([a.walletId, b.walletId, systemWalletId]);
  });

  it('cannot create money: refuses when the recipient already spent it, and flags it for a human', async () => {
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    await fund(a, 100_000);
    const id = await transfer(a, b, 100_000);
    await transfer(b, c, 60_000); // b spends most of it
    const res = await reverse(id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(a.walletId)).toBe(0n);
    expect(await balanceOf(b.walletId)).toBe(40_000n);
    const [original] = await db.select().from(transactions).where(eq(transactions.publicId, id));
    expect(await db.select().from(transactions).where(eq(transactions.reversalOfTransactionId, original!.id))).toHaveLength(0);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.userId, admin.userId));
    expect(logs.some((l) => l.action === 'REVERSAL_BLOCKED_INSUFFICIENT_FUNDS' && l.severity === 'CRITICAL')).toBe(true);
  });

  it('works on frozen wallets because it is an operations action', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const id = await transfer(a, b, 100_000);
    await db.update(wallets).set({ status: 'FROZEN' }).where(eq(wallets.id, a.walletId));
    await db.update(wallets).set({ status: 'FROZEN' }).where(eq(wallets.id, b.walletId));
    expect((await reverse(id)).status).toBe(201);
    expect(await balanceOf(a.walletId)).toBe(100_000n);
  });

  it('only reverses successful transfers', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 5_000);
    expect((await send(a, b, 50_000)).status).toBe(422); // leaves a FAILED record
    const [failed] = (await db.select().from(transactions).where(eq(transactions.senderWalletId, a.walletId))).filter((t) => t.status === 'FAILED');
    expect((await reverse(failed!.publicId)).status).toBe(400);

    const [funding] = await db.select().from(transactions).where(eq(transactions.receiverWalletId, a.walletId));
    expect((await reverse(funding!.publicId)).status).toBe(400); // add-money is not a user transfer

    const id = await transfer(a, b, 1_000);
    const rev = (await reverse(id)).body.data.reversal.id as string;
    expect((await reverse(rev)).status).toBe(400); // a reversal cannot itself be reversed
    expect((await reverse('TXN_AAAAAAAAAAAA')).status).toBe(404);
  });

  it('is admin-only and needs a real reason', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const id = await transfer(a, b, 1_000);
    expect((await a.b.post(`/api/v1/admin/transactions/${id}/reverse`, { reason: 'I want my money back' })).status).toBe(403);
    expect((await admin.b.post(`/api/v1/admin/transactions/${id}/reverse`, { reason: 'no' })).status).toBe(400);
    expect(await balanceOf(b.walletId)).toBe(1_000n);
  });
});
