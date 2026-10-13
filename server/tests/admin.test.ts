import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { auditLogs, outboxEvents, systemSettings, users } from '../src/db/schema/index.js';
import { clearSettingsCache } from '../src/modules/settings/settings.service.js';
import { reconcile } from '../src/modules/reconciliation/reconciliation.service.js';
import { closeRedis, getRedis } from '../src/redis/client.js';
import { assertLedgerConsistent, balanceOf, browser, ensureSystemWallet, fund, newAdmin, newUser, PASSWORD, PIN, send, uniq, type TestUser } from './helpers.js';

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

const A = '/api/v1/admin';
const freshStats = async () => {
  await getRedis().del('cache:admin:stats');
  return (await admin.b.get(`${A}/stats`)).body.data.stats;
};
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
const auditFor = async (userId: string) => db.select().from(auditLogs).where(eq(auditLogs.userId, userId)).orderBy(desc(auditLogs.id));

describe('access control', () => {
  it('refuses anonymous callers and ordinary users on every admin endpoint', async () => {
    const user = await newUser();
    for (const path of ['/stats', '/users', `/users/${user.userId}`, '/transactions', '/audit-logs', '/suspicious', '/reconciliation']) {
      expect((await browser().get(A + path)).status).toBe(401);
      const res = await user.b.get(A + path);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect((await user.b.post(`${A}/users/${user.userId}/freeze`, { reason: 'trying my luck' })).status).toBe(403);
  });

  it('takes effect immediately when an administrator is demoted or suspended, without waiting for the token to expire', async () => {
    const demoted = await newAdmin();
    expect((await demoted.b.get(`${A}/stats`)).status).toBe(200);
    await db.update(users).set({ role: 'USER' }).where(eq(users.id, demoted.userId));
    expect((await demoted.b.get(`${A}/stats`)).status).toBe(403); // same, still-valid access token

    const suspended = await newAdmin();
    await db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, suspended.userId));
    expect((await suspended.b.get(`${A}/users`)).status).toBe(403);
  });
});

describe('dashboard statistics', () => {
  it('reports platform totals, caches them, and reflects new activity once the cache is refreshed', async () => {
    const first = await admin.b.get(`${A}/stats`);
    expect(first.body.data.stats).toMatchObject({ users: expect.any(Object), wallets: expect.any(Object), today: expect.any(Object), alerts: expect.any(Object) });
    const second = await admin.b.get(`${A}/stats`);
    expect(second.body.data.stats.generatedAt).toBe(first.body.data.stats.generatedAt); // served from Redis

    const before = await freshStats();
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 500_000);
    expect((await send(a, b, 30_000)).status).toBe(201);
    expect((await send(a, b, 1_000_000)).status).toBe(422); // a failed attempt (over the balance, under the per-transfer maximum)
    const after = await freshStats();

    expect(after.users.total - before.users.total).toBe(2);
    expect(BigInt(after.wallets.totalBalance) - BigInt(before.wallets.totalBalance)).toBe(500_000n); // money in, not counting the platform wallet
    expect(after.today.transactions - before.today.transactions).toBe(3); // add money + transfer + failed
    expect(after.today.successful - before.today.successful).toBe(2);
    expect(after.today.failed - before.today.failed).toBe(1);
    expect(BigInt(after.today.addMoneyVolume) - BigInt(before.today.addMoneyVolume)).toBe(500_000n);
    expect(BigInt(after.today.transferVolume) - BigInt(before.today.transferVolume)).toBe(30_000n);
    expect(after.today.failureRatePercent).toBeGreaterThan(0);
  });
});

describe('user management', () => {
  it('searches, filters and paginates users, and shows each wallet', async () => {
    const tag = uniq();
    const made = [] as TestUser[];
    for (let i = 0; i < 3; i++) made.push(await newUser({ name: `Searchable ${tag} ${i}` }));
    const found = await admin.b.get(`${A}/users?q=${tag}&limit=2`);
    expect(found.body.data.items).toHaveLength(2);
    const next = await admin.b.get(`${A}/users?q=${tag}&limit=2&cursor=${found.body.data.nextCursor}`);
    expect(next.body.data.items).toHaveLength(1);
    expect(next.body.data.nextCursor).toBeNull();
    const ids = [...found.body.data.items, ...next.body.data.items].map((u: { id: string }) => u.id).sort();
    expect(ids).toEqual(made.map((m) => m.userId).sort());
    expect(found.body.data.items[0].wallet).toMatchObject({ balance: '0', status: 'ACTIVE' });
    expect(JSON.stringify(found.body)).not.toContain('passwordHash');

    expect((await admin.b.get(`${A}/users?q=${encodeURIComponent('%')}`)).body.data.items.every((u: { name: string; email: string }) => (u.name + u.email).includes('%'))).toBe(true); // % is literal
    expect((await admin.b.get(`${A}/users?role=ADMIN&limit=50`)).body.data.items.every((u: { role: string }) => u.role === 'ADMIN')).toBe(true);
    expect((await admin.b.get(`${A}/users?status=NOPE`)).status).toBe(400);
  });

  it('shows a full account view and audits that an admin looked', async () => {
    const [u, other] = [await newUser({ name: 'Detail Subject' }), await newUser()];
    await fund(u, 100_000);
    await send(u, other, 10_000);
    await send(u, other, 1_000_000); // fails: insufficient balance, so it is recorded
    const res = await admin.b.get(`${A}/users/${u.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ user: { name: 'Detail Subject', wallet: { balance: '90000' } }, activeSessions: 1, failedTransactions: 1 });
    expect(res.body.data.recentTransactions.length).toBe(3);
    expect(res.body.data.recentAudit.length).toBeGreaterThan(0);
    expect((await auditFor(admin.userId)).some((l) => l.action === 'ADMIN_VIEWED_USER' && l.targetUserId === u.userId)).toBe(true);
    expect((await admin.b.get(`${A}/users/${randomUUID()}`)).status).toBe(404);
    expect((await admin.b.get(`${A}/users/not-a-uuid`)).status).toBe(400);
  });

  it('force logout signs the user out everywhere and is audited', async () => {
    const u = await newUser();
    expect((await u.b.get('/api/v1/users/me')).status).toBe(200);
    expect((await admin.b.post(`${A}/users/${u.userId}/force-logout`)).status).toBe(200);
    expect((await u.b.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await auditFor(admin.userId)).some((l) => l.action === 'FORCE_LOGOUT' && l.targetUserId === u.userId)).toBe(true);
    expect((await admin.b.post(`${A}/users/${randomUUID()}/force-logout`)).status).toBe(404);
  });
});

describe('freezing accounts', () => {
  it('freezes with a reason, records who and why, and invalidates caches', async () => {
    const u = await newUser();
    await u.b.get('/api/v1/users/me'); // warms the cached profile
    expect(await getRedis().exists(`cache:user:${u.userId}`)).toBe(1);

    expect((await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'no' })).status).toBe(400); // reason required
    const res = await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'Suspected account takeover' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.wallet).toMatchObject({ status: 'FROZEN', freezeReason: 'Suspected account takeover', frozenBy: admin.userId });
    expect(res.body.data.user.wallet.frozenAt).toBeTruthy();
    expect(await getRedis().exists(`cache:user:${u.userId}`)).toBe(0);

    const log = (await auditFor(admin.userId)).find((l) => l.action === 'ACCOUNT_FROZEN' && l.targetUserId === u.userId);
    expect(log).toMatchObject({ severity: 'CRITICAL', metadata: { reason: 'Suspected account takeover' } });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, u.userId));
    expect(events.map((e) => e.eventType)).toContain('ACCOUNT_FROZEN');
    expect((await admin.b.get(`${A}/users?wallet=FROZEN&q=${encodeURIComponent(u.email)}`)).body.data.items).toHaveLength(1);
  });

  it('stops every way of moving money but still lets the user log in and look', async () => {
    const [u, other] = [await newUser(), await newUser()];
    await fund(u, 100_000);
    await fund(other, 100_000);
    const acct = (await u.b.post('/api/v1/bank-accounts', { holderName: 'Asha Rao', upiId: 'asha.rao@okbank', pin: PIN })).body.data.bankAccount.id as string;
    const request = (await other.b.post('/api/v1/payment-requests', { payerEmail: u.email, amount: 5_000 })).body.data.request.id as string;
    expect((await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'Compliance review' })).status).toBe(200);

    expect((await send(u, other, 1_000)).body.error.code).toBe('WALLET_FROZEN');
    expect((await u.b.post('/api/v1/wallet/add-money', { amount: 10_000 }, { 'idempotency-key': randomUUID() })).body.error.code).toBe('WALLET_FROZEN');
    expect((await u.b.post('/api/v1/wallet/withdraw', { bankAccountId: acct, amount: 1_000, pin: PIN }, { 'idempotency-key': randomUUID() })).body.error.code).toBe('WALLET_FROZEN');
    expect((await u.b.post(`/api/v1/payment-requests/${request}/pay`, { pin: PIN }, { 'idempotency-key': randomUUID() })).body.error.code).toBe('WALLET_FROZEN');
    expect((await send(other, u, 1_000)).body.error.code).toBe('RECEIVER_WALLET_FROZEN');
    expect(await balanceOf(u.walletId)).toBe(100_000n);

    // ...but they can still sign in, see the freeze, and read their history.
    const login = await browser();
    await login.init();
    expect((await login.post('/api/v1/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    expect((await u.b.get('/api/v1/wallet')).body.data.wallet).toMatchObject({ status: 'FROZEN', freezeReason: 'Compliance review' });
    expect((await u.b.get('/api/v1/transactions')).status).toBe(200);
  });

  it('refuses double freezes, unfreezing the active, administrators, yourself and strangers', async () => {
    const u = await newUser();
    const other = await newAdmin();
    expect((await admin.b.post(`${A}/users/${u.userId}/unfreeze`)).status).toBe(400); // not frozen
    expect((await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'First freeze' })).status).toBe(200);
    expect((await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'Second freeze' })).status).toBe(400);
    expect((await admin.b.post(`${A}/users/${other.userId}/freeze`, { reason: 'Admins are exempt' })).status).toBe(403);
    expect((await admin.b.post(`${A}/users/${admin.userId}/freeze`, { reason: 'Locking myself out' })).status).toBe(403);
    expect((await admin.b.post(`${A}/users/${randomUUID()}/freeze`, { reason: 'Nobody home' })).status).toBe(404);
  });

  it('unfreezing restores normal operation and is audited', async () => {
    const [u, other] = [await newUser(), await newUser()];
    await fund(u, 100_000);
    await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'Temporary hold' });
    expect((await send(u, other, 1_000)).status).toBe(423);
    const res = await admin.b.post(`${A}/users/${u.userId}/unfreeze`);
    expect(res.body.data.user.wallet).toMatchObject({ status: 'ACTIVE', freezeReason: null, frozenAt: null, frozenBy: null });
    expect((await send(u, other, 1_000)).status).toBe(201);
    expect((await auditFor(admin.userId)).some((l) => l.action === 'ACCOUNT_UNFROZEN' && l.targetUserId === u.userId)).toBe(true);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, u.userId));
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['ACCOUNT_FROZEN', 'ACCOUNT_UNFROZEN']));
  });

  it('takes effect immediately under load: payments already running finish, everything after the freeze is refused', async () => {
    const [u, other] = [await newUser(), await newUser()];
    await fund(u, 1_000_000);
    const sends = Array.from({ length: 30 }, () => send(u, other, 1_000));
    await new Promise((r) => setTimeout(r, 150)); // let some of them get going
    const freeze = await admin.b.post(`${A}/users/${u.userId}/freeze`, { reason: 'Frozen mid-flight' });
    expect(freeze.status).toBe(200);
    const results = await Promise.all(sends);

    for (const r of results) expect([201, 423]).toContain(r.status); // each payment either completed first or was refused, never half done
    const succeeded = results.filter((r) => r.status === 201).length;
    expect(await balanceOf(u.walletId)).toBe(1_000_000n - BigInt(succeeded) * 1_000n);
    expect(await balanceOf(other.walletId)).toBe(BigInt(succeeded) * 1_000n);

    // Once the freeze call has returned, no further payment can get through.
    const after = await Promise.all(Array.from({ length: 10 }, () => send(u, other, 1_000)));
    expect(after.every((r) => r.status === 423 && r.body.error.code === 'WALLET_FROZEN')).toBe(true);
    expect(await balanceOf(u.walletId)).toBe(1_000_000n - BigInt(succeeded) * 1_000n);
    expect((await reconcile({ walletIds: [u.walletId, other.walletId] })).ok).toBe(true);
    await assertLedgerConsistent([u.walletId, other.walletId, systemWalletId]);
  });
});

describe('transaction monitoring', () => {
  let a: TestUser, b: TestUser;
  let okId = '';
  const note = `monitored ${uniq()}`; // unique per run: the test database persists between runs
  beforeAll(async () => {
    [a, b] = [await newUser({ name: 'Monitor Alpha' }), await newUser({ name: 'Monitor Beta' })];
    await fund(a, 500_000);
    okId = (await send(a, b, 25_000, { note })).body.data.transaction.id;
    await send(a, b, 1_000_000); // FAILED: insufficient balance, so it is recorded
  });

  it('lists transactions across all wallets, including failed attempts other users would never see', async () => {
    const failed = await admin.b.get(`${A}/transactions?status=FAILED&userId=${a.userId}`);
    expect(failed.body.data.items).toHaveLength(1);
    expect(failed.body.data.items[0]).toMatchObject({ status: 'FAILED', failureCode: 'INSUFFICIENT_BALANCE', sender: { name: 'Monitor Alpha' }, receiver: { name: 'Monitor Beta' } });
    expect(failed.body.data.items[0].requestId).toBeTruthy();
    expect((await b.b.get('/api/v1/transactions?status=FAILED')).body.data.items).toHaveLength(0); // the recipient cannot see it, the admin can

    const involving = await admin.b.get(`${A}/transactions?userId=${b.userId}&limit=50`);
    expect(involving.body.data.items.map((t: { id: string }) => t.id)).toContain(okId);
    expect((await admin.b.get(`${A}/transactions?q=${okId}`)).body.data.items.map((t: { id: string }) => t.id)).toEqual([okId]);
    expect((await admin.b.get(`${A}/transactions?q=${encodeURIComponent(note)}`)).body.data.items).toHaveLength(1);
    expect((await admin.b.get(`${A}/transactions?type=ADD_MONEY&userId=${a.userId}`)).body.data.items).toHaveLength(1);
    expect((await admin.b.get(`${A}/transactions?userId=${a.userId}&minAmount=20000&maxAmount=30000`)).body.data.items.map((t: { id: string }) => t.id)).toEqual([okId]);
    const future = encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString());
    expect((await admin.b.get(`${A}/transactions?from=${future}`)).body.data.items).toHaveLength(0);
    expect((await admin.b.get(`${A}/transactions?status=NOPE`)).status).toBe(400);
  });

  it('pages through the platform history without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const res: { body: { data: { items: { id: string }[]; nextCursor: string | null } } } = await admin.b.get(`${A}/transactions?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.data.items.map((t) => t.id));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(15);
    expect(new Set(seen).size).toBe(15);
  });

  it('opens a transaction with parties, ledger entries, reversal state and audit trail, and supports reversing it', async () => {
    const detail = (await admin.b.get(`${A}/transactions/${okId}`)).body.data.transaction;
    expect(detail).toMatchObject({ id: okId, status: 'SUCCESS', canReverse: true, reversedBy: null, hasIdempotencyKey: true });
    expect(detail.ledgerEntries).toHaveLength(2);
    expect(detail.ledgerEntries.map((e: { type: string; wallet: { name: string } }) => `${e.type}:${e.wallet.name}`).sort()).toEqual(['CREDIT:Monitor Beta', 'DEBIT:Monitor Alpha']);
    const debit = detail.ledgerEntries.find((e: { type: string }) => e.type === 'DEBIT');
    expect([debit.balanceBefore, debit.balanceAfter]).toEqual(['500000', '475000']);

    expect((await admin.b.post(`${A}/transactions/${okId}/reverse`, { reason: 'Reversed from the admin console' })).status).toBe(201);
    const after = (await admin.b.get(`${A}/transactions/${okId}`)).body.data.transaction;
    expect(after.canReverse).toBe(false);
    expect(after.reversedBy).toMatch(/^TXN_/);
    expect(after.auditTrail.some((x: { action: string }) => x.action === 'TRANSACTION_REVERSED')).toBe(true);

    const failedId = (await admin.b.get(`${A}/transactions?status=FAILED&userId=${a.userId}`)).body.data.items[0].id;
    const failed = (await admin.b.get(`${A}/transactions/${failedId}`)).body.data.transaction;
    expect(failed).toMatchObject({ status: 'FAILED', canReverse: false, failureCode: 'INSUFFICIENT_BALANCE', ledgerEntries: [] });
    expect((await admin.b.get(`${A}/transactions/TXN_AAAAAAAAAAAA`)).status).toBe(404);
    expect((await admin.b.get(`${A}/transactions/bogus`)).status).toBe(400);
  });
});

describe('audit log and suspicious activity', () => {
  it('filters by action, severity, user and date, and pages without duplicates', async () => {
    const u = await newUser();
    for (let i = 0; i < 4; i++) await admin.b.get(`${A}/users/${u.userId}`); // 4 ADMIN_VIEWED_USER entries
    const viewed = await admin.b.get(`${A}/audit-logs?action=ADMIN_VIEWED_USER&userId=${u.userId}&limit=3`);
    expect(viewed.body.data.items).toHaveLength(3);
    expect(viewed.body.data.items[0]).toMatchObject({ action: 'ADMIN_VIEWED_USER', actor: { id: admin.userId, email: admin.email }, target: { id: u.userId, email: u.email } });
    expect(viewed.body.data.items[0].requestId).toBeTruthy();
    const more = await admin.b.get(`${A}/audit-logs?action=ADMIN_VIEWED_USER&userId=${u.userId}&limit=3&cursor=${viewed.body.data.nextCursor}`);
    const ids = [...viewed.body.data.items, ...more.body.data.items].map((x: { id: string }) => x.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect((await admin.b.get(`${A}/audit-logs?severity=CRITICAL&limit=50`)).body.data.items.every((x: { severity: string }) => x.severity === 'CRITICAL')).toBe(true);
    const future = encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString());
    expect((await admin.b.get(`${A}/audit-logs?from=${future}`)).body.data.items).toHaveLength(0);
    expect((await admin.b.get(`${A}/audit-logs?cursor=garbage`)).status).toBe(400);
    expect((await admin.b.get(`${A}/audit-logs?limit=1000`)).status).toBe(400);
  });

  it('flags velocity, large amounts and large first-time payees without ever blocking the payment', async () => {
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    await fund(a, 2_000_000);
    await getRedis().del(`fraud:velocity:${a.userId}`);

    await withSetting('fraud.velocity_count', 4, async () => {
      for (let i = 0; i < 6; i++) expect((await send(a, b, 1_000)).status).toBe(201); // every one goes through
    });
    await withSetting('fraud.large_amount', 50_000, async () => {
      expect((await send(a, b, 60_000)).status).toBe(201);
      expect((await send(a, b, 10_000)).status).toBe(201);
    });
    await withSetting('fraud.new_payee_amount', 20_000, async () => {
      expect((await send(a, c, 30_000)).status).toBe(201); // first ever transfer to c, and large
      expect((await send(a, c, 30_000)).status).toBe(201); // c is no longer new
    });

    const flags = (await admin.b.get(`${A}/audit-logs?action=SUSPICIOUS_ACTIVITY&userId=${a.userId}&limit=50`)).body.data.items as { metadata: { rule: string; amount: string } }[];
    const count = (rule: string) => flags.filter((f) => f.metadata.rule === rule).length;
    expect(count('HIGH_VELOCITY')).toBe(1); // one alert for the burst, not one per transfer
    expect(count('LARGE_AMOUNT')).toBe(1); // only the 60,000 reaches the 50,000 threshold
    expect(count('NEW_PAYEE_LARGE_AMOUNT')).toBe(1); // the first 30,000 to c, not the second
  });

  it('shows only watch-listed events on the suspicious screen', async () => {
    const res = await admin.b.get(`${A}/suspicious?limit=100`);
    expect(res.status).toBe(200);
    const watched = ['SUSPICIOUS_ACTIVITY', 'PIN_LOCKED', 'REFRESH_TOKEN_REUSE_DETECTED', 'REVERSAL_BLOCKED_INSUFFICIENT_FUNDS', 'RECONCILIATION_FAILED', 'GATEWAY_AMOUNT_MISMATCH'];
    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const item of res.body.data.items) expect(watched.includes(item.action) || item.severity === 'CRITICAL').toBe(true);
    expect(res.body.data.items.some((i: { action: string }) => i.action === 'ADMIN_VIEWED_USER')).toBe(false);
  });
});

describe('create-admin script', () => {
  it('creates an administrator who can log in, and refuses a weak password', () => {
    const email = `cli-${uniq()}@test.local`;
    const run = (pw: string) => spawnSync('npx', ['tsx', 'scripts/create-admin.ts', email, 'CLI Admin', pw], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
    expect(run('weak').status).toBe(1);
    const ok = run(PASSWORD);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('is now an ADMIN');
  }, 60_000);
});
