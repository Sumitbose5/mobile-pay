import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/client.js';
import { closeRedis } from '../src/redis/client.js';
import { ensureSystemWallet, fund, newUser, send, type TestUser } from './helpers.js';

type Item = { id: string; type: string; direction: string; status: string; amount: string; signedAmount: string; counterparty: { name: string; email: string } | null; note: string | null; createdAt: string };
const list = async (u: TestUser, qs = '') => {
  const res = await u.b.get(`/api/v1/transactions${qs ? `?${qs}` : ''}`);
  return { res, items: (res.body.data?.items ?? []) as Item[], next: res.body.data?.nextCursor as string | null };
};

let a: TestUser, b: TestUser, c: TestUser;
const sentIds: string[] = [];

beforeAll(async () => {
  await ensureSystemWallet();
  [a, b, c] = [await newUser({ name: 'Sumit Kumar' }), await newUser({ name: 'Rahul Sharma' }), await newUser({ name: 'Amit Verma' })];
  await fund(a, 1_000_000);
  // 12 transfers a -> b with varying amounts and notes, 2 a -> c, 1 b -> a, plus one failure
  for (let i = 0; i < 12; i++) {
    const r = await send(a, b, 1_000 * (i + 1), { note: i === 3 ? 'Birthday gift 100%' : `Payment ${i}` });
    expect(r.status).toBe(201);
    sentIds.push(r.body.data.transaction.id);
  }
  await send(a, c, 5_000, { note: 'Lunch' });
  await send(a, c, 7_000);
  await send(b, a, 2_000, { note: 'Refund' });
  expect((await send(c, a, 99_999_9)).status).toBe(422); // c has 12,000; this fails and is recorded
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe('transaction history', () => {
  it('lists newest first with direction, counterparty and signed amounts from the viewer\'s side', async () => {
    const { items } = await list(a, 'limit=50');
    expect(items[0]).toMatchObject({ direction: 'RECEIVED', note: 'Refund' }); // newest; c's failed attempt to pay a is not shown to a
    const refund = items.find((i) => i.note === 'Refund')!;
    expect(refund).toMatchObject({ direction: 'RECEIVED', signedAmount: '2000', counterparty: { name: 'Rahul Sharma' } });
    const gift = items.find((i) => i.note === 'Birthday gift 100%')!;
    expect(gift).toMatchObject({ direction: 'SENT', signedAmount: '-4000', counterparty: { name: 'Rahul Sharma' } });
    expect(items.find((i) => i.type === 'ADD_MONEY')).toMatchObject({ direction: 'ADDED', counterparty: null });
    const times = items.map((i) => new Date(i.createdAt).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    // the receiver sees the same transfer from the other side
    const bItems = (await list(b, 'limit=50')).items;
    expect(bItems.find((i) => i.note === 'Birthday gift 100%')).toMatchObject({ direction: 'RECEIVED', signedAmount: '4000', counterparty: { name: 'Sumit Kumar' } });
  });

  it('pages with a cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { items, next }: { items: Item[]; next: string | null } = await list(a, `limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...items.map((i) => i.id));
      cursor = next;
      pages++;
    } while (cursor && pages < 10);
    const all = (await list(a, 'limit=50')).items.map((i) => i.id);
    expect(pages).toBe(Math.ceil(all.length / 5));
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters by direction, type, status and amount range', async () => {
    expect((await list(a, 'direction=RECEIVED&limit=50')).items.map((i) => i.note)).toEqual(['Refund']);
    expect((await list(a, 'type=ADD_MONEY')).items).toHaveLength(1);
    const sentOnly = (await list(a, 'direction=SENT&type=TRANSFER&limit=50')).items;
    expect(sentOnly).toHaveLength(14); // 12 to b + 2 to c
    expect(sentOnly.every((i) => i.direction === 'SENT')).toBe(true);
    const range = (await list(a, 'direction=SENT&minAmount=5000&maxAmount=7000&limit=50')).items.map((i) => i.amount).sort();
    expect(range).toEqual(['5000', '5000', '6000', '7000', '7000']);
    const failed = (await list(c, 'status=FAILED')).items;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'FAILED', signedAmount: '0' });
    expect((await list(a, 'status=FAILED')).items).toHaveLength(0);
  });

  it('filters by date range', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await list(a, `from=${encodeURIComponent(future)}`)).items).toHaveLength(0);
    expect((await list(a, `from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}&limit=50`)).items.length).toBeGreaterThan(10);
  });

  it('searches notes, counterparty names, emails and transaction ids, treating % and _ literally', async () => {
    expect((await list(a, 'q=lunch')).items.map((i) => i.note)).toEqual(['Lunch']);
    expect((await list(a, 'q=amit%20verma&limit=50')).items).toHaveLength(2);
    expect((await list(a, `q=${encodeURIComponent(b.email)}&limit=50`)).items).toHaveLength(13);
    expect((await list(a, `q=${sentIds[0]}`)).items.map((i) => i.id)).toEqual([sentIds[0]]);
    expect((await list(a, `q=${encodeURIComponent('100%')}`)).items.map((i) => i.note)).toEqual(['Birthday gift 100%']);
    expect((await list(a, `q=${encodeURIComponent('%')}&limit=50`)).items).toHaveLength(1); // not a wildcard
    expect((await list(a, 'q=zzzznothing')).items).toHaveLength(0);
  });

  it('hides a failed attempt to pay you from you, but shows it to the sender', async () => {
    expect((await list(a, 'status=FAILED')).items).toHaveLength(0);
    const failedId = (await list(c, 'status=FAILED')).items[0]!.id;
    expect((await a.b.get(`/api/v1/transactions/${failedId}`)).status).toBe(404);
  });

  it('filters money added to the wallet', async () => {
    expect((await list(a, 'direction=ADDED')).items.map((i) => i.type)).toEqual(['ADD_MONEY']);
  });

  it('never shows another user\'s transactions', async () => {
    const outsider = await newUser();
    expect((await list(outsider, 'limit=50')).items).toHaveLength(0);
    const cItems = (await list(c, 'limit=50')).items;
    expect(cItems.every((i) => ['Lunch', null].includes(i.note) || i.status === 'FAILED')).toBe(true);
  });

  it('validates the query string and requires authentication', async () => {
    expect((await a.b.get('/api/v1/transactions?limit=500')).status).toBe(400);
    expect((await a.b.get('/api/v1/transactions?status=NOPE')).status).toBe(400);
    expect((await a.b.get('/api/v1/transactions?cursor=garbage')).status).toBe(400);
    expect((await (await import('./helpers.js')).browser().get('/api/v1/transactions')).status).toBe(401);
  });
});

describe('transaction details', () => {
  it('shows both parties and the viewer\'s balance before and after', async () => {
    const id = sentIds[0]!;
    const res = await a.b.get(`/api/v1/transactions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.transaction).toMatchObject({
      id,
      status: 'SUCCESS',
      type: 'TRANSFER',
      direction: 'SENT',
      amount: '1000',
      sender: { name: 'Sumit Kumar', email: a.email },
      receiver: { name: 'Rahul Sharma', email: b.email },
      balanceBefore: '1000000',
      balanceAfter: '999000',
    });
    expect(res.body.data.transaction.completedAt).toBeTruthy();
    const receiverView = await b.b.get(`/api/v1/transactions/${id}`);
    expect(receiverView.body.data.transaction).toMatchObject({ direction: 'RECEIVED', balanceBefore: '0', balanceAfter: '1000' });
  });

  it('explains a failed transaction', async () => {
    const failed = (await list(c, 'status=FAILED')).items[0]!;
    const res = await c.b.get(`/api/v1/transactions/${failed.id}`);
    expect(res.body.data.transaction).toMatchObject({ status: 'FAILED', failureCode: 'INSUFFICIENT_BALANCE', balanceBefore: null });
  });

  it('returns 404, not 403, for a transaction you are not part of or that does not exist', async () => {
    expect((await c.b.get(`/api/v1/transactions/${sentIds[0]}`)).status).toBe(404);
    expect((await a.b.get('/api/v1/transactions/TXN_AAAAAAAAAAAA')).status).toBe(404);
    expect((await a.b.get('/api/v1/transactions/not-an-id')).status).toBe(400);
  });
});

describe('recipient lookup', () => {
  it('confirms a recipient by email but not yourself or strangers', async () => {
    const ok = await a.b.get(`/api/v1/wallet/recipients/lookup?email=${encodeURIComponent(b.email)}`);
    expect(ok.body.data.recipient).toMatchObject({ name: 'Rahul Sharma' });
    expect(ok.body.data.recipient).not.toHaveProperty('email');
    expect((await a.b.get(`/api/v1/wallet/recipients/lookup?email=${encodeURIComponent(a.email)}`)).status).toBe(400);
    expect((await a.b.get('/api/v1/wallet/recipients/lookup?email=ghost@test.local')).status).toBe(404);
  });
});
