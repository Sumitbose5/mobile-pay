import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { outboxEvents, paymentRequests, transactions } from '../src/db/schema/index.js';
import { expireRequests } from '../src/modules/payment-requests/requests.service.js';
import { closeRedis, getRedis } from '../src/redis/client.js';
import { assertLedgerConsistent, balanceOf, ensureSystemWallet, fund, newUser, PIN, type TestUser } from './helpers.js';

let systemWalletId = '';
beforeAll(async () => {
  systemWalletId = await ensureSystemWallet();
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

const request = (from: TestUser, to: TestUser, amount: number | string = 50_000, extra: Record<string, unknown> = {}) =>
  from.b.post('/api/v1/payment-requests', { payerEmail: to.email, amount, ...extra });
const pay = (payer: TestUser, id: string, pin = PIN, key: string = randomUUID()) =>
  payer.b.post(`/api/v1/payment-requests/${id}/pay`, { pin }, { 'idempotency-key': key });
const idOf = (res: { body: { data: { request: { id: string } } } }) => res.body.data.request.id;
const statusOf = async (id: string) => (await db.select().from(paymentRequests).where(eq(paymentRequests.id, id)))[0]!.status;

async function pair(fundPayer = 500_000) {
  const [requester, payer] = [await newUser({ name: 'Rahul Sharma' }), await newUser({ name: 'Sumit Kumar' })];
  if (fundPayer) await fund(payer, fundPayer);
  return { requester, payer };
}

describe('creating requests', () => {
  it('creates a request that both sides can see, and queues a notification event for the payer', async () => {
    const { requester, payer } = await pair();
    const res = await request(requester, payer, 50_000, { note: 'Dinner' });
    expect(res.status).toBe(201);
    expect(res.body.data.request).toMatchObject({ amount: '50000', note: 'Dinner', status: 'PENDING', requester: { name: 'Rahul Sharma' }, payer: { name: 'Sumit Kumar' }, transactionId: null });
    const id = idOf(res);
    expect((await payer.b.get('/api/v1/payment-requests?box=received')).body.data.items.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await requester.b.get('/api/v1/payment-requests?box=sent')).body.data.items.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await payer.b.get('/api/v1/payment-requests?box=sent')).body.data.items).toHaveLength(0);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, id));
    expect(events.map((e) => e.eventType)).toEqual(['REQUEST_CREATED']);
  });

  it('rejects yourself, strangers, bad amounts and out-of-range amounts', async () => {
    const { requester, payer } = await pair(0);
    expect((await request(requester, requester)).body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(requester, { ...payer, email: 'ghost@test.local' } as TestUser)).status).toBe(404);
    expect((await request(requester, payer, 0)).status).toBe(400);
    expect((await request(requester, payer, '1.5')).status).toBe(400);
    expect((await request(requester, payer, 50)).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await request(requester, payer, 5_000_001)).body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('allows at most 20 open requests even when 25 are created at the same moment', async () => {
    const { requester, payer } = await pair(0);
    const results = await Promise.all(Array.from({ length: 25 }, () => request(requester, payer, 10_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(results.filter((r) => r.status === 422 && r.body.error.code === 'LIMIT_EXCEEDED')).toHaveLength(5);
    expect((await db.select().from(paymentRequests).where(eq(paymentRequests.requesterId, requester.userId)))).toHaveLength(20);
  });

  it('paginates and filters by status', async () => {
    const { requester, payer } = await pair(0);
    for (let i = 0; i < 5; i++) await request(requester, payer, 10_000 + i);
    const first = await payer.b.get('/api/v1/payment-requests?limit=2');
    expect(first.body.data.items).toHaveLength(2);
    const second = await payer.b.get(`/api/v1/payment-requests?limit=2&cursor=${first.body.data.nextCursor}`);
    const third = await payer.b.get(`/api/v1/payment-requests?limit=2&cursor=${second.body.data.nextCursor}`);
    expect([...first.body.data.items, ...second.body.data.items, ...third.body.data.items]).toHaveLength(5);
    expect(third.body.data.nextCursor).toBeNull();
    const rejected = idOf(await request(requester, payer, 12_000));
    await payer.b.post(`/api/v1/payment-requests/${rejected}/reject`);
    expect((await payer.b.get('/api/v1/payment-requests?status=REJECTED')).body.data.items).toHaveLength(1);
    expect((await payer.b.get('/api/v1/payment-requests?status=NOPE')).status).toBe(400);
  });
});

describe('paying a request', () => {
  it('moves the money through the normal send path and marks the request PAID in the same commit', async () => {
    const { requester, payer } = await pair();
    const id = idOf(await request(requester, payer, 50_000, { note: 'Dinner' }));
    const res = await pay(payer, id);
    expect(res.status).toBe(201);
    expect(res.body.data.request).toMatchObject({ status: 'PAID' });
    expect(res.body.data.request.transactionId).toBe(res.body.data.transaction.id);

    expect(await balanceOf(payer.walletId)).toBe(450_000n);
    expect(await balanceOf(requester.walletId)).toBe(50_000n);
    const [txn] = await db.select().from(transactions).where(eq(transactions.publicId, res.body.data.transaction.id));
    expect(txn).toMatchObject({ type: 'TRANSFER', status: 'SUCCESS', paymentRequestId: id, senderWalletId: payer.walletId, receiverWalletId: requester.walletId, note: 'Dinner' });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, id));
    expect(events.map((e) => e.eventType).sort()).toEqual(['REQUEST_CREATED', 'REQUEST_PAID']);
    await assertLedgerConsistent([payer.walletId, requester.walletId, systemWalletId]);
  });

  it('cannot be paid twice, and a second attempt neither moves money nor spends a PIN attempt', async () => {
    const { requester, payer } = await pair();
    const id = idOf(await request(requester, payer, 50_000));
    expect((await pay(payer, id)).status).toBe(201);
    const again = await pay(payer, id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REQUEST_NOT_PENDING');
    const wrongPinOnPaid = await pay(payer, id, '1357');
    expect(wrongPinOnPaid.body.error.code).toBe('REQUEST_NOT_PENDING'); // not INVALID_PIN: no attempt was spent
    expect(await getRedis().get(`pin:attempts:${payer.userId}`)).toBeNull();
    expect(await balanceOf(payer.walletId)).toBe(450_000n);
  });

  it('replays the stored result for the same Idempotency-Key', async () => {
    const { requester, payer } = await pair();
    const id = idOf(await request(requester, payer, 50_000));
    const key = randomUUID();
    const first = await pay(payer, id, PIN, key);
    const replay = await pay(payer, id, PIN, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.transaction.id).toBe(first.body.data.transaction.id);
    expect(await balanceOf(requester.walletId)).toBe(50_000n);
  });

  it('keeps the request PENDING on a wrong PIN or insufficient balance', async () => {
    const { requester, payer } = await pair(10_000);
    const id = idOf(await request(requester, payer, 50_000));
    expect((await pay(payer, id, '1357')).body.error.code).toBe('INVALID_PIN');
    await getRedis().del(`pin:attempts:${payer.userId}`);
    const broke = await pay(payer, id);
    expect(broke.status).toBe(422);
    expect(broke.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await statusOf(id)).toBe('PENDING');
    expect(await balanceOf(payer.walletId)).toBe(10_000n);
    await fund(payer, 100_000);
    expect((await pay(payer, id)).status).toBe(201); // can still be paid once funded
  });

  it('only the payer can pay; outsiders and the requester get 404', async () => {
    const { requester, payer } = await pair();
    const outsider = await newUser();
    const id = idOf(await request(requester, payer, 50_000));
    expect((await pay(requester, id)).status).toBe(404);
    expect((await pay(outsider, id)).status).toBe(404);
    expect((await outsider.b.get(`/api/v1/payment-requests/${id}`)).status).toBe(404);
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('refuses an expired request, and the scheduled job expires overdue ones and tells the requester', async () => {
    const { requester, payer } = await pair();
    const id = idOf(await request(requester, payer, 50_000));
    await db.update(paymentRequests).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(paymentRequests.id, id));
    const late = await pay(payer, id);
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/expired/);

    expect(await expireRequests()).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe('EXPIRED');
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, id));
    expect(events.map((e) => e.eventType)).toContain('REQUEST_EXPIRED');
    const paid = idOf(await request(requester, payer, 10_000));
    await pay(payer, paid);
    await expireRequests();
    expect(await statusOf(paid)).toBe('PAID'); // settled requests are never touched
    expect(await balanceOf(payer.walletId)).toBe(490_000n);
  });
});

describe('rejecting and cancelling', () => {
  it('lets the payer reject and the requester cancel, but not the other way round', async () => {
    const { requester, payer } = await pair();
    const toReject = idOf(await request(requester, payer, 20_000));
    const toCancel = idOf(await request(requester, payer, 30_000));
    expect((await requester.b.post(`/api/v1/payment-requests/${toReject}/reject`)).status).toBe(404);
    expect((await payer.b.post(`/api/v1/payment-requests/${toCancel}/cancel`)).status).toBe(404);
    expect((await payer.b.post(`/api/v1/payment-requests/${toReject}/reject`)).body.data.request.status).toBe('REJECTED');
    expect((await requester.b.post(`/api/v1/payment-requests/${toCancel}/cancel`)).body.data.request.status).toBe('CANCELLED');
    expect((await pay(payer, toReject)).body.error.code).toBe('REQUEST_NOT_PENDING');
    expect((await pay(payer, toCancel)).body.error.code).toBe('REQUEST_NOT_PENDING');
    expect((await payer.b.post(`/api/v1/payment-requests/${toReject}/reject`)).status).toBe(409);
    const events = await db.select().from(outboxEvents);
    expect(events.some((e) => e.aggregateId === toReject && e.eventType === 'REQUEST_REJECTED')).toBe(true);
    expect(events.some((e) => e.aggregateId === toCancel && e.eventType === 'REQUEST_CANCELLED')).toBe(true);
    expect(await balanceOf(payer.walletId)).toBe(500_000n);
  });
});

describe('races: a request ends exactly one way', () => {
  it('pay and reject at the same moment produce one outcome and never both', async () => {
    for (let round = 0; round < 5; round++) {
      const { requester, payer } = await pair();
      const id = idOf(await request(requester, payer, 50_000));
      const [p, r] = await Promise.all([pay(payer, id), payer.b.post(`/api/v1/payment-requests/${id}/reject`)]);
      const paid = p.status === 201;
      const rejected = r.status === 200;
      expect(paid !== rejected).toBe(true); // exactly one succeeded
      const final = await statusOf(id);
      if (paid) {
        expect(final).toBe('PAID');
        expect(await balanceOf(requester.walletId)).toBe(50_000n);
      } else {
        expect(final).toBe('REJECTED');
        expect(await balanceOf(requester.walletId)).toBe(0n);
        expect(await db.select().from(transactions).where(eq(transactions.paymentRequestId, id))).toHaveLength(0);
      }
    }
  });

  it('pay and cancel at the same moment never leave a paid-and-cancelled request', async () => {
    const { requester, payer } = await pair();
    const id = idOf(await request(requester, payer, 50_000));
    const [p, c] = await Promise.all([pay(payer, id), requester.b.post(`/api/v1/payment-requests/${id}/cancel`)]);
    expect((p.status === 201) !== (c.status === 200)).toBe(true);
    const final = await statusOf(id);
    expect(final).toBe(p.status === 201 ? 'PAID' : 'CANCELLED');
  });

  it('8 parallel payments with different keys transfer the money exactly once', async () => {
    const { requester, payer } = await pair();
    const id = idOf(await request(requester, payer, 50_000));
    const results = await Promise.all(Array.from({ length: 8 }, () => pay(payer, id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect(r.status).toBe(409);
    expect(await balanceOf(requester.walletId)).toBe(50_000n);
    expect(await balanceOf(payer.walletId)).toBe(450_000n);
    expect(await db.select().from(transactions).where(eq(transactions.paymentRequestId, id))).toHaveLength(1);
    await assertLedgerConsistent([payer.walletId, requester.walletId, systemWalletId]);
  });
});
