import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDb, db } from '../src/db/client.js';
import { ledgerEntries, outboxEvents, paymentOrders, systemSettings, transactions, users, wallets } from '../src/db/schema/index.js';
import { sentMail } from '../src/lib/mailer.js';
import { getRedis, closeRedis } from '../src/redis/client.js';
import { assertLedgerConsistent } from './helpers.js';
import { signPayload } from '../src/modules/payments/payments.service.js';
import { clearSettingsCache } from '../src/modules/settings/settings.service.js';

const app = createApp();
const PASSWORD = 'Str0ngPassw0rd';
const PIN = '2580';
const uniq = () => Math.random().toString(36).slice(2, 10);

function browser() {
  const agent = request.agent(app);
  let csrf = '';
  const sync = (res: Response) => {
    for (const c of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const m = /^csrf_token=([^;]+)/.exec(c);
      if (m?.[1]) csrf = decodeURIComponent(m[1]);
    }
    return res;
  };
  const withHeaders = (r: request.Test, headers?: Record<string, string>) => {
    for (const [k, v] of Object.entries(headers ?? {})) r.set(k, v);
    return r;
  };
  return {
    init: async () => sync(await agent.get('/api/v1/auth/csrf')),
    get: async (p: string) => sync(await agent.get(p)),
    post: async (p: string, body?: object, headers?: Record<string, string>) =>
      sync(await withHeaders(agent.post(p).set('x-csrf-token', csrf), headers).send(body)),
    put: async (p: string, body?: object) => sync(await agent.put(p).set('x-csrf-token', csrf).send(body)),
  };
}
type Browser = ReturnType<typeof browser>;

async function newUser(opts: { pin?: boolean } = { pin: true }) {
  const email = `w-${uniq()}@test.local`;
  const b = browser();
  await b.init();
  await b.post('/api/v1/auth/register', { name: 'Wallet User', email, password: PASSWORD });
  const mail = [...sentMail].reverse().find((m) => m.to === email && /Verify/.test(m.subject));
  const token = /token=([\w-]+)/.exec(mail?.text ?? '')![1];
  await b.post('/api/v1/auth/verify-email', { token });
  expect((await b.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  if (opts.pin !== false) expect((await b.post('/api/v1/users/me/pin', { password: PASSWORD, pin: PIN })).status).toBe(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  const [w] = await db.select().from(wallets).where(eq(wallets.userId, u!.id));
  return { b, email, userId: u!.id, walletId: w!.id };
}

const addMoney = (b: Browser, amount: number | string, key: string = randomUUID()) =>
  b.post('/api/v1/wallet/add-money', { amount }, { 'idempotency-key': key });

const balanceOf = async (walletId: string) => (await db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!.balance;

function signedWebhook(event: object, opts: { timestamp?: string; secretTamper?: boolean } = {}) {
  const raw = JSON.stringify(event);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = signPayload(timestamp, opts.secretTamper ? raw + ' ' : raw);
  return request(app)
    .post('/api/v1/payments/webhook')
    .set('content-type', 'application/json')
    .set('x-gateway-timestamp', timestamp)
    .set('x-gateway-signature', signature)
    .send(raw);
}

async function pendingOrder(u: Awaited<ReturnType<typeof newUser>>, amount = 50_000) {
  const res = await addMoney(u.b, amount);
  expect(res.status).toBe(201);
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, res.body.data.order.id));
  return order!;
}

let systemWalletId: string;
beforeAll(async () => {
  await db.insert(wallets).values({ isSystem: true, userId: null }).onConflictDoNothing();
  systemWalletId = (await db.select().from(wallets).where(eq(wallets.isSystem, true)))[0]!.id;
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe('transaction PIN', () => {
  it('requires the password to set a PIN, rejects weak PINs and never stores it in plain text', async () => {
    const u = await newUser({ pin: false });
    expect((await u.b.post('/api/v1/users/me/pin', { password: 'Wrong-Passw0rd', pin: PIN })).status).toBe(401);
    expect((await u.b.post('/api/v1/users/me/pin', { password: PASSWORD, pin: '1234' })).status).toBe(400);
    expect((await u.b.post('/api/v1/users/me/pin', { password: PASSWORD, pin: '0000' })).status).toBe(400);
    expect((await u.b.post('/api/v1/users/me/pin', { password: PASSWORD, pin: PIN })).status).toBe(201);
    expect((await u.b.post('/api/v1/users/me/pin', { password: PASSWORD, pin: '9753' })).status).toBe(400); // already set
    const [row] = await db.select().from(users).where(eq(users.id, u.userId));
    expect(row?.transactionPinHash?.startsWith('$argon2id$')).toBe(true);
    expect((await u.b.get('/api/v1/users/me')).body.data.user.hasTransactionPin).toBe(true);
  });

  it('locks PIN entry after 3 wrong attempts, even for the right PIN, and alerts the owner', async () => {
    const u = await newUser();
    const attempt = (pin: string) => u.b.put('/api/v1/users/me/pin', { currentPin: pin, newPin: '9753' });
    const first = await attempt('1111');
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe('INVALID_PIN');
    expect((await attempt('2222')).status).toBe(401);
    const third = await attempt('3333');
    expect(third.status).toBe(423);
    expect(third.body.error.code).toBe('PIN_LOCKED');
    expect((await attempt(PIN)).body.error.code).toBe('PIN_LOCKED');
    expect(sentMail.some((m) => m.to === u.email && /locked/.test(m.subject))).toBe(true);
    await getRedis().del(`pin:lock:${u.userId}`);
  });

  it('changes the PIN with the current PIN', async () => {
    const u = await newUser();
    expect((await u.b.put('/api/v1/users/me/pin', { currentPin: PIN, newPin: '9753' })).status).toBe(200);
    expect((await u.b.put('/api/v1/users/me/pin', { currentPin: PIN, newPin: '8642' })).status).toBe(401);
    await getRedis().del(`pin:attempts:${u.userId}`);
  });
});

describe('wallet', () => {
  it('has a zero-balance ACTIVE wallet after verification and serializes money as strings', async () => {
    const u = await newUser();
    const res = await u.b.get('/api/v1/wallet');
    expect(res.status).toBe(200);
    expect(res.body.data.wallet).toMatchObject({ balance: '0', currency: 'INR', status: 'ACTIVE' });
    expect((await u.b.get('/api/v1/wallet/balance')).body.data.balance).toBe('0');
  });
});

describe('add money', () => {
  it('requires a transaction PIN to be set', async () => {
    const u = await newUser({ pin: false });
    const res = await addMoney(u.b, 50_000);
    expect(res.status).toBe(412);
    expect(res.body.error.code).toBe('PIN_NOT_SET');
  });

  it('credits the wallet through the ledger when the gateway confirms payment', async () => {
    const u = await newUser();
    const order = await pendingOrder(u, 150_000);
    expect(await balanceOf(u.walletId)).toBe(0n); // creating an order moves no money

    const done = await u.b.post(`/api/v1/payments/simulator/${order.id}/complete`, { outcome: 'SUCCESS' });
    expect(done.status).toBe(200);
    expect(done.body.data.order.status).toBe('SUCCESS');
    expect(await balanceOf(u.walletId)).toBe(150_000n);

    const txns = await db.select().from(transactions).where(eq(transactions.paymentOrderId, order.id));
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ type: 'ADD_MONEY', status: 'SUCCESS', amount: 150_000n, senderWalletId: systemWalletId, receiverWalletId: u.walletId });
    expect(txns[0]?.publicId).toMatch(/^TXN_[0-9A-Z]{12}$/);
    expect(txns[0]?.completedAt).not.toBeNull();

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, txns[0]!.id));
    expect(entries.map((e) => `${e.type}:${e.walletId === u.walletId ? 'user' : 'system'}:${e.amount}`).sort()).toEqual(['CREDIT:user:150000', 'DEBIT:system:150000']);
    const credit = entries.find((e) => e.type === 'CREDIT')!;
    expect([credit.balanceBefore, credit.balanceAfter]).toEqual([0n, 150_000n]);

    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, txns[0]!.id));
    expect(events.map((e) => e.eventType)).toEqual(['MONEY_ADDED']);
    await assertLedgerConsistent([u.walletId, systemWalletId]);
  });

  it('does not credit when the payment fails', async () => {
    const u = await newUser();
    const order = await pendingOrder(u);
    const res = await u.b.post(`/api/v1/payments/simulator/${order.id}/complete`, { outcome: 'FAILED' });
    expect(res.body.data.order.status).toBe('FAILED');
    expect(await balanceOf(u.walletId)).toBe(0n);
    expect(await db.select().from(transactions).where(eq(transactions.paymentOrderId, order.id))).toHaveLength(0);
  });

  it('enforces minimum, maximum and wallet-balance limits', async () => {
    const u = await newUser();
    expect((await addMoney(u.b, 999)).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await addMoney(u.b, 5_000_001)).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await addMoney(u.b, 0)).status).toBe(400);
    expect((await addMoney(u.b, '12.5')).status).toBe(400);

    await db.insert(systemSettings).values({ key: 'limits.max_wallet_balance', value: 100_000 }).onConflictDoUpdate({ target: systemSettings.key, set: { value: 100_000 } });
    clearSettingsCache();
    try {
      expect((await addMoney(u.b, 100_001)).body.error.code).toBe('LIMIT_EXCEEDED');
      expect((await addMoney(u.b, 100_000)).status).toBe(201);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, 'limits.max_wallet_balance'));
      clearSettingsCache();
    }
  });

  it('refuses to start, and refuses to credit, a frozen wallet', async () => {
    const u = await newUser();
    const order = await pendingOrder(u);
    await db.update(wallets).set({ status: 'FROZEN', freezeReason: 'test' }).where(eq(wallets.id, u.walletId));
    expect((await addMoney(u.b, 50_000)).body.error.code).toBe('WALLET_FROZEN');

    // Frozen between order creation and payment confirmation: the freeze wins, nothing is credited.
    const res = await u.b.post(`/api/v1/payments/simulator/${order.id}/complete`, { outcome: 'SUCCESS' });
    expect(res.body.data.order.status).toBe('FAILED');
    expect(res.body.data.order.failureReason).toBe('wallet_frozen');
    expect(await balanceOf(u.walletId)).toBe(0n);
  });

  it('only lets the owner see an order', async () => {
    const a = await newUser();
    const b = await newUser();
    const order = await pendingOrder(a);
    expect((await a.b.get(`/api/v1/payments/orders/${order.id}`)).status).toBe(200);
    expect((await b.b.get(`/api/v1/payments/orders/${order.id}`)).status).toBe(404);
    expect((await b.b.post(`/api/v1/payments/simulator/${order.id}/complete`, { outcome: 'SUCCESS' })).status).toBe(404);
  });
});

describe('idempotency', () => {
  it('replays the stored response for the same key and body', async () => {
    const u = await newUser();
    const key = randomUUID();
    const first = await addMoney(u.b, 20_000, key);
    const second = await addMoney(u.b, 20_000, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.order.id).toBe(first.body.data.order.id);
    expect(await db.select().from(paymentOrders).where(eq(paymentOrders.userId, u.userId))).toHaveLength(1);
  });

  it('rejects the same key with a different body, and requests without a key', async () => {
    const u = await newUser();
    const key = randomUUID();
    await addMoney(u.b, 20_000, key);
    const reused = await addMoney(u.b, 30_000, key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await u.b.post('/api/v1/wallet/add-money', { amount: 20_000 });
    expect(missing.status).toBe(400);
  });

  it('creates exactly one order when the same request is fired 10 times in parallel', async () => {
    const u = await newUser();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => addMoney(u.b, 25_000, key)));
    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(new Set(created.map((r) => r.body.data.order.id)).size).toBe(1);
    expect(await db.select().from(paymentOrders).where(eq(paymentOrders.userId, u.userId))).toHaveLength(1);
  });

  it('scopes keys per user', async () => {
    const a = await newUser();
    const b = await newUser();
    const key = randomUUID();
    const ra = await addMoney(a.b, 20_000, key);
    const rb = await addMoney(b.b, 20_000, key);
    expect(ra.body.data.order.id).not.toBe(rb.body.data.order.id);
  });
});

describe('gateway webhook', () => {
  const event = (o: typeof paymentOrders.$inferSelect, extra: object = {}) => ({
    orderId: o.gatewayOrderId,
    paymentId: `pay_${uniq()}${uniq()}`,
    status: 'SUCCESS',
    amount: o.amount.toString(),
    ...extra,
  });

  it('accepts a correctly signed event and credits once', async () => {
    const u = await newUser();
    const order = await pendingOrder(u, 70_000);
    const res = await signedWebhook(event(order));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUCCESS');
    expect(await balanceOf(u.walletId)).toBe(70_000n);
  });

  it('is idempotent: replaying the same event does not credit again', async () => {
    const u = await newUser();
    const order = await pendingOrder(u, 70_000);
    const ev = event(order);
    expect((await signedWebhook(ev)).body.data.duplicate).toBe(false);
    const again = await signedWebhook(ev);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(await balanceOf(u.walletId)).toBe(70_000n);
  });

  it('credits exactly once when the same event is delivered 20 times in parallel', async () => {
    const u = await newUser();
    const order = await pendingOrder(u, 80_000);
    const ev = event(order);
    const results = await Promise.all(Array.from({ length: 20 }, () => signedWebhook(ev)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.duplicate === false)).toHaveLength(1);
    expect(await balanceOf(u.walletId)).toBe(80_000n);
    expect(await db.select().from(transactions).where(eq(transactions.paymentOrderId, order.id))).toHaveLength(1);
    await assertLedgerConsistent([u.walletId, systemWalletId]);
  });

  it('rejects missing, forged, tampered and stale signatures', async () => {
    const u = await newUser();
    const order = await pendingOrder(u);
    const raw = JSON.stringify(event(order));
    const unsigned = await request(app).post('/api/v1/payments/webhook').set('content-type', 'application/json').send(raw);
    expect(unsigned.status).toBe(401);
    expect((await signedWebhook(event(order), { secretTamper: true })).status).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 3_600);
    expect((await signedWebhook(event(order), { timestamp: stale })).status).toBe(401);
    expect(await balanceOf(u.walletId)).toBe(0n);
  });

  it('fails the order when the paid amount differs from the order amount', async () => {
    const u = await newUser();
    const order = await pendingOrder(u, 50_000);
    const res = await signedWebhook(event(order, { amount: '5000000' }));
    expect(res.body.data.status).toBe('FAILED');
    expect(await balanceOf(u.walletId)).toBe(0n);
    const [after] = await db.select().from(paymentOrders).where(and(eq(paymentOrders.id, order.id)));
    expect(after?.failureReason).toBe('amount_mismatch');
  });

  it('returns 404 for an unknown order and 400 for a malformed payload', async () => {
    expect((await signedWebhook({ orderId: 'order_nope', paymentId: 'pay_x', status: 'SUCCESS', amount: '100' })).status).toBe(404);
    expect((await signedWebhook({ orderId: 'x' })).status).toBe(400);
  });
});
