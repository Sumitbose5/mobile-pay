// Queue keys are isolated per run, and backoff is shortened so retry behaviour can be observed in milliseconds.
process.env.QUEUE_PREFIX = `test-${Math.random().toString(36).slice(2, 8)}`;
process.env.EMAIL_BACKOFF_MS = '50';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db } = await import('../src/db/client.js');
const { idempotencyKeys, notifications, outboxEvents, paymentOrders, refreshTokens, auditLogs, transactions } = await import('../src/db/schema/index.js');
const { dispatchOutbox } = await import('../src/jobs/outbox.js');
const { startBackgroundJobs, registerSchedules } = await import('../src/jobs/workers.js');
const { cleanupIdempotencyKeys, cleanupRefreshTokens, expirePaymentOrders, runReconciliationJob } = await import('../src/jobs/maintenance.js');
const { __setMailTransportForTests, notice, sentMail } = await import('../src/lib/mailer.js');
const { formatInr } = await import('../src/lib/money.js');
const { createNotification } = await import('../src/modules/notifications/notifications.service.js');
const { enqueueEmail, enqueueNotification } = await import('../src/queues/jobs.js');
const { closeQueues, getQueue, QUEUES } = await import('../src/queues/queues.js');
const { closeRedis, getRedis } = await import('../src/redis/client.js');
const { ensureSystemWallet, fund, newAdmin, newUser, send, browser, uniq } = await import('./helpers.js');
type TestUser = Awaited<ReturnType<typeof newUser>>;

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
const notificationsOf = (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));
const mailTo = (email: string) => sentMail.filter((m) => m.to === email);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await ensureSystemWallet();
  // Ignore events left behind by other test files so this file controls exactly what is dispatched.
  await db.update(outboxEvents).set({ status: 'PROCESSED' }).where(eq(outboxEvents.status, 'PENDING'));
  jobs = startBackgroundJobs({ outbox: false });
});
afterAll(async () => {
  __setMailTransportForTests(null);
  await jobs.stop();
  for (const name of Object.values(QUEUES)) await getQueue(name).obliterate({ force: true }).catch(() => undefined);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe('outbox -> notifications and email', () => {
  it('turns a committed transfer into in-app notifications and emails for both people', async () => {
    const [a, b] = [await newUser({ name: 'Sumit Kumar' }), await newUser({ name: 'Rahul Sharma' })];
    await fund(a, 1_000_000);
    expect((await send(a, b, 25_000)).status).toBe(201);
    await dispatchOutbox();

    const sent = await waitFor(async () => (await notificationsOf(a.userId)).find((n) => n.type === 'MONEY_SENT'));
    const received = await waitFor(async () => (await notificationsOf(b.userId)).find((n) => n.type === 'MONEY_RECEIVED'));
    expect(sent.message).toBe('You sent ₹250.00 to Rahul Sharma.');
    expect(received.message).toBe('₹250.00 received from Sumit Kumar.');
    expect(received.isRead).toBe(false);

    await waitFor(async () => mailTo(a.email).some((m) => m.subject === 'You sent ₹250.00 to Rahul Sharma') && mailTo(b.email).some((m) => m.subject === 'You received ₹250.00 from Sumit Kumar'));
    const pending = await db.select().from(outboxEvents).where(eq(outboxEvents.status, 'PENDING'));
    expect(pending).toHaveLength(0);
  });

  it('honours email preferences but still creates the in-app notification', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    expect((await b.b.patch('/api/v1/users/me/notification-preferences', { emailMoneyReceived: false })).status).toBe(200);
    expect((await send(a, b, 10_000)).status).toBe(201);
    await dispatchOutbox();

    await waitFor(async () => (await notificationsOf(b.userId)).length === 1);
    await waitFor(async () => mailTo(a.email).some((m) => /You sent/.test(m.subject))); // the sender's mail went out...
    await settle(300);
    expect(mailTo(b.email).filter((m) => /received/i.test(m.subject))).toHaveLength(0); // ...the muted receiver's did not
  });

  it('is idempotent: a replayed job or dedupe key creates one notification', async () => {
    const u = await newUser();
    const job = { userId: u.userId, type: 'SYSTEM', title: 'Hello', message: 'Once only', dedupeKey: `t-${uniq()}` };
    expect(await createNotification(job)).toBe(true);
    expect(await createNotification(job)).toBe(false);
    const id = `same-${uniq()}`;
    const second = { ...job, dedupeKey: `t-${uniq()}` };
    await enqueueNotification(second, id);
    await enqueueNotification(second, id); // BullMQ drops the duplicate job id
    await waitFor(async () => (await notificationsOf(u.userId)).length === 2);
    await settle(300);
    expect(await notificationsOf(u.userId)).toHaveLength(2);
  });

  it('lets several dispatchers run at once and handles every event exactly once', async () => {
    const u = await newUser();
    const rows = Array.from({ length: 20 }, () => ({ aggregateType: 'transaction', aggregateId: randomUUID(), eventType: 'MONEY_ADDED', payload: { userId: u.userId, amount: '10000', publicId: 'TXN_RACE00000000', transactionId: randomUUID() } }));
    const inserted = await db.insert(outboxEvents).values(rows).returning({ id: outboxEvents.id });
    const ids = inserted.map((r) => r.id);

    let total = 0;
    for (let round = 0; round < 10; round++) {
      const counts = await Promise.all([dispatchOutbox(5), dispatchOutbox(5), dispatchOutbox(5)]);
      expect(counts.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(15);
      total += counts.reduce((x, y) => x + y, 0);
      if (counts.every((c) => c === 0)) break;
    }
    expect(total).toBe(20);
    const after = await db.select().from(outboxEvents).where(inArray(outboxEvents.id, ids));
    expect(after.every((e) => e.status === 'PROCESSED' && e.attempts === 1)).toBe(true); // claimed exactly once each
    await waitFor(async () => (await notificationsOf(u.userId)).length === 20);
    await settle(300);
    expect(await notificationsOf(u.userId)).toHaveLength(20);
  });

  it('ignores unknown event types instead of retrying them forever', async () => {
    const [row] = await db.insert(outboxEvents).values({ aggregateType: 'x', aggregateId: randomUUID(), eventType: 'SOMETHING_NEW', payload: {} }).returning();
    await dispatchOutbox();
    expect((await db.select().from(outboxEvents).where(eq(outboxEvents.id, row!.id)))[0]?.status).toBe('PROCESSED');
  });
});

describe('email delivery', () => {
  it('retries a failing SMTP server with backoff and does not lose the message', async () => {
    let calls = 0;
    __setMailTransportForTests({ sendMail: async () => { if (++calls < 3) throw new Error('SMTP unavailable'); return {} as never; } });
    const to = `retry-${uniq()}@test.local`;
    await enqueueEmail(notice(to, 'Retry me', ['hello']));
    await waitFor(async () => mailTo(to).length === 1);
    expect(calls).toBe(3); // two failures, then success
    __setMailTransportForTests(null);
  });

  it('keeps a permanently failing email in the failed set (dead letter) after its attempts', async () => {
    let calls = 0;
    __setMailTransportForTests({ sendMail: async () => { calls++; throw new Error('SMTP down'); } });
    const to = `dead-${uniq()}@test.local`;
    const job = await enqueueEmail(notice(to, 'Never arrives', ['x']));
    const failed = await waitFor(async () => (await getQueue(QUEUES.email).getFailed()).find((j) => j.id === job.id), 15_000);
    expect(failed.attemptsMade).toBe(5);
    expect(calls).toBe(5);
    expect(mailTo(to)).toHaveLength(0);
    __setMailTransportForTests(null);
  });
});

describe('notifications API', () => {
  async function seed(u: TestUser, n: number) {
    for (let i = 0; i < n; i++) await createNotification({ userId: u.userId, type: 'SYSTEM', title: `Title ${i}`, message: `Message ${i}`, dedupeKey: `seed-${uniq()}-${i}` });
  }

  it('lists newest first with cursor pagination and an unread filter', async () => {
    const u = await newUser();
    await seed(u, 7);
    const first = await u.b.get('/api/v1/notifications?limit=3');
    expect(first.body.data.items.map((n: { title: string }) => n.title)).toEqual(['Title 6', 'Title 5', 'Title 4']);
    const second = await u.b.get(`/api/v1/notifications?limit=3&cursor=${first.body.data.nextCursor}`);
    expect(second.body.data.items.map((n: { title: string }) => n.title)).toEqual(['Title 3', 'Title 2', 'Title 1']);
    const third = await u.b.get(`/api/v1/notifications?limit=3&cursor=${second.body.data.nextCursor}`);
    expect(third.body.data.items).toHaveLength(1);
    expect(third.body.data.nextCursor).toBeNull();
    expect((await u.b.get('/api/v1/notifications?limit=500')).status).toBe(400);
    expect((await u.b.get('/api/v1/notifications?cursor=garbage')).status).toBe(400);
  });

  it('counts unread through a cache that is invalidated by reads and new notifications', async () => {
    const u = await newUser();
    await seed(u, 3);
    expect((await u.b.get('/api/v1/notifications/unread-count')).body.data.count).toBe(3);
    expect(await getRedis().exists(`cache:unread:${u.userId}`)).toBe(1); // served from Redis next time

    const [one] = (await u.b.get('/api/v1/notifications')).body.data.items;
    expect((await u.b.post(`/api/v1/notifications/${one.id}/read`)).status).toBe(404); // wrong verb: PATCH only
    const readRes = await u.b.patch(`/api/v1/notifications/${one.id}/read`);
    expect(readRes.status).toBe(200);
    expect((await u.b.get('/api/v1/notifications/unread-count')).body.data.count).toBe(2);

    await createNotification({ userId: u.userId, type: 'SYSTEM', title: 'New', message: 'New', dedupeKey: `new-${uniq()}` });
    expect((await u.b.get('/api/v1/notifications/unread-count')).body.data.count).toBe(3);

    const all = await u.b.post('/api/v1/notifications/read-all');
    expect(all.body.data.updated).toBe(3);
    expect((await u.b.get('/api/v1/notifications/unread-count')).body.data.count).toBe(0);
    expect((await u.b.get('/api/v1/notifications?unread=true')).body.data.items).toHaveLength(0);
  });

  it("never lets one user read or modify another's notifications", async () => {
    const [a, b] = [await newUser(), await newUser()];
    await seed(a, 1);
    const [mine] = (await a.b.get('/api/v1/notifications')).body.data.items;
    expect((await b.b.get('/api/v1/notifications')).body.data.items).toHaveLength(0);
    expect((await b.b.patch(`/api/v1/notifications/${mine.id}/read`)).status).toBe(404);
    expect((await browser().get('/api/v1/notifications')).status).toBe(401);
  });
});

describe('caching', () => {
  it('serves /users/me from Redis and drops the cached copy when the profile or PIN changes', async () => {
    const u = await newUser({ pin: false });
    expect((await u.b.get('/api/v1/users/me')).body.data.user.hasTransactionPin).toBe(false);
    expect(await getRedis().exists(`cache:user:${u.userId}`)).toBe(1);
    expect((await u.b.post('/api/v1/users/me/pin', { password: 'Str0ngPassw0rd', pin: '2580' })).status).toBe(201);
    expect(await getRedis().exists(`cache:user:${u.userId}`)).toBe(0); // invalidated by the PIN change
    expect((await u.b.get('/api/v1/users/me')).body.data.user.hasTransactionPin).toBe(true);
  });

  it("shows this month's totals and refreshes them as soon as money moves", async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 500_000);
    const before = (await a.b.get('/api/v1/transactions/summary')).body.data.summary;
    expect(before).toMatchObject({ added: '500000', sent: '0', received: '0', count: 1 });
    expect(await getRedis().exists(`cache:summary:${a.walletId}`)).toBe(1);

    expect((await send(a, b, 30_000)).status).toBe(201);
    const after = (await a.b.get('/api/v1/transactions/summary')).body.data.summary; // not stale
    expect(after).toMatchObject({ added: '500000', sent: '30000', received: '0', count: 2 });
    expect((await b.b.get('/api/v1/transactions/summary')).body.data.summary).toMatchObject({ received: '30000', sent: '0' });
  });
});

describe('maintenance jobs', () => {
  it('deletes only expired idempotency keys', async () => {
    const u = await newUser();
    const base = { userId: u.userId, endpoint: 'x', requestHash: 'a'.repeat(64) };
    await db.insert(idempotencyKeys).values([
      { ...base, key: `old-${uniq()}-padding`, expiresAt: new Date(Date.now() - 60_000) },
      { ...base, key: `new-${uniq()}-padding`, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);
    expect(await cleanupIdempotencyKeys()).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, u.userId));
    expect(left.map((k) => k.key.startsWith('new-'))).toEqual([true]);
  });

  it('purges an expired idempotency key even when a real transaction points at it, keeping the transaction', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const res = await send(a, b, 10_000);
    expect(res.status).toBe(201);
    const [txn] = await db.select().from(transactions).where(eq(transactions.publicId, res.body.data.transaction.id));
    expect(txn?.idempotencyKeyId).not.toBeNull();
    await db.update(idempotencyKeys).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(idempotencyKeys.id, txn!.idempotencyKeyId!));

    await cleanupIdempotencyKeys(); // used to fail with a foreign-key violation
    const [after] = await db.select().from(transactions).where(eq(transactions.id, txn!.id));
    expect(after).toMatchObject({ status: 'SUCCESS', idempotencyKeyId: null, amount: 10_000n });
  });

  it('expires unpaid payment orders after a grace period, but not fresh ones', async () => {
    const u = await newUser();
    const mk = (mins: number) => ({ userId: u.userId, walletId: u.walletId, amount: 10_000n, gatewayOrderId: `order_${uniq()}${uniq()}`, expiresAt: new Date(Date.now() - mins * 60_000) });
    const [stale] = await db.insert(paymentOrders).values(mk(180)).returning();
    const [recent] = await db.insert(paymentOrders).values(mk(10)).returning();
    expect(await expirePaymentOrders(60)).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(paymentOrders).where(eq(paymentOrders.id, stale!.id)))[0]?.status).toBe('EXPIRED');
    expect((await db.select().from(paymentOrders).where(eq(paymentOrders.id, recent!.id)))[0]?.status).toBe('CREATED');
  });

  it('removes long-dead refresh tokens but keeps recent evidence', async () => {
    const u = await newUser();
    const fam = randomUUID();
    const mk = (over: Partial<typeof refreshTokens.$inferInsert>) => ({ userId: u.userId, familyId: fam, tokenHash: `h-${uniq()}${uniq()}${uniq()}`, expiresAt: new Date(Date.now() + 86_400_000), ...over });
    const day = 86_400_000;
    await db.insert(refreshTokens).values([
      mk({ expiresAt: new Date(Date.now() - 10 * day) }), // expired long ago: delete
      mk({ revokedAt: new Date(Date.now() - 40 * day) }), // revoked long ago: delete
      mk({ revokedAt: new Date(Date.now() - 2 * day) }), // revoked recently: keep for investigations
    ]);
    const before = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, u.userId), eq(refreshTokens.familyId, fam)));
    expect(before.length).toBeGreaterThanOrEqual(3);
    await cleanupRefreshTokens();
    const left = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, u.userId), eq(refreshTokens.familyId, fam)));
    expect(left.filter((t) => t.familyId === fam)).toHaveLength(1);
  });

  it('raises an alert to admins when reconciliation fails, and stays quiet when it passes', async () => {
    const admin = await newAdmin();
    const report = (ok: boolean) => async () => ({
      ok, scope: 'full' as const, ranAt: new Date().toISOString(), durationMs: 1,
      checks: [{ name: 'balance_matches_ledger', description: 'd', ok, violations: ok ? [] : [{ wallet_id: 'w' }], violationCount: ok ? 0 : 1 }],
    });
    await runReconciliationJob(report(true));
    await settle(400);
    expect((await notificationsOf(admin.userId)).filter((n) => n.title === 'Reconciliation failed')).toHaveLength(0);

    await runReconciliationJob(report(false));
    const alert = await waitFor(async () => (await notificationsOf(admin.userId)).find((n) => n.title === 'Reconciliation failed'));
    expect(alert.message).toContain('balance_matches_ledger (1)');
    expect(mailTo(admin.email).some((m) => /reconciliation failed/i.test(m.subject))).toBe(true);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'RECONCILIATION_FAILED'));
    expect(logs.some((l) => l.severity === 'CRITICAL')).toBe(true);
  });

  it('registers each repeatable job once, however many times the worker starts', async () => {
    await registerSchedules();
    await registerSchedules();
    const ids = (await getQueue(QUEUES.maintenance).getJobSchedulers()).map((s) => s.key ?? s.id).sort();
    expect(ids).toEqual(['cleanup-expired-requests', 'cleanup-idempotency-keys', 'cleanup-refresh-tokens', 'expire-payment-orders', 'reconcile-ledger']);
  });
});

describe('queue dashboard and formatting', () => {
  it('shows the read-only queue dashboard to admins only', async () => {
    const admin = await newAdmin();
    const user = await newUser();
    expect((await user.b.get('/api/v1/admin/queues/')).status).toBe(403);
    expect((await browser().get('/api/v1/admin/queues/')).status).toBe(401);
    expect([200, 302]).toContain((await admin.b.get('/api/v1/admin/queues/')).status);
  });

  it('formats paise with Indian digit grouping', () => {
    expect(formatInr(5n)).toBe('₹0.05');
    expect(formatInr(100_000n)).toBe('₹1,000.00');
    expect(formatInr(12_345_678n)).toBe('₹1,23,456.78');
    expect(formatInr(99_999_999n)).toBe('₹9,99,999.99');
    expect(formatInr(-2_500n)).toBe('-₹25.00');
  });
});
