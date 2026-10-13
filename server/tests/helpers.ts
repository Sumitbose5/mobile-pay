import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { ledgerEntries, users, wallets } from '../src/db/schema/index.js';
import { sentMail } from '../src/lib/mailer.js';
import { hashPassword } from '../src/lib/password.js';

export const app = createApp();
export const PASSWORD = 'Str0ngPassw0rd';
export const PIN = '2580';
export const uniq = () => Math.random().toString(36).slice(2, 10);

/** Browser-like client: cookie jar plus automatic CSRF header, like the SPA. */
export function browser() {
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
    patch: async (p: string, body?: object) => sync(await agent.patch(p).set('x-csrf-token', csrf).send(body)),
    put: async (p: string, body?: object) => sync(await agent.put(p).set('x-csrf-token', csrf).send(body)),
    del: async (p: string) => sync(await agent.delete(p).set('x-csrf-token', csrf)),
    raw: async (p: string) => agent.get(p),
  };
}
export type Browser = ReturnType<typeof browser>;

export async function newUser(opts: { pin?: boolean; name?: string } = {}) {
  const email = `t-${uniq()}@test.local`;
  const b = browser();
  await b.init();
  await b.post('/api/v1/auth/register', { name: opts.name ?? 'Test User', email, password: PASSWORD });
  const mail = [...sentMail].reverse().find((m) => m.to === email && /Verify/.test(m.subject));
  await b.post('/api/v1/auth/verify-email', { token: /token=([\w-]+)/.exec(mail?.text ?? '')![1] });
  expect((await b.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  if (opts.pin !== false) expect((await b.post('/api/v1/users/me/pin', { password: PASSWORD, pin: PIN })).status).toBe(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  const [w] = await db.select().from(wallets).where(eq(wallets.userId, u!.id));
  return { b, email, userId: u!.id, walletId: w!.id };
}
export type TestUser = Awaited<ReturnType<typeof newUser>>;

export const balanceOf = async (walletId: string) => (await db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!.balance;

/** Gives a wallet money the legitimate way: a system-funded ADD_MONEY through the real ledger code path. */
export async function fund(u: TestUser, amount: number | bigint) {
  const { applyTransfer, getSystemWallet } = await import('../src/modules/wallet/ledger.js');
  await db.transaction(async (tx) => {
    const sys = await getSystemWallet(tx);
    await applyTransfer(tx, { type: 'ADD_MONEY', senderWalletId: sys.id, receiverWalletId: u.walletId, amount: BigInt(amount), initiatedBy: u.userId });
  });
}

export const send = (from: TestUser, to: { email?: string }, amount: number | string, extra: Record<string, unknown> = {}, key: string = randomUUID()) =>
  from.b.post('/api/v1/wallet/send', { receiverEmail: to.email, amount, pin: PIN, ...extra }, { 'idempotency-key': key });

export async function ensureSystemWallet(): Promise<string> {
  await db.insert(wallets).values({ isSystem: true, userId: null }).onConflictDoNothing();
  return (await db.select().from(wallets).where(eq(wallets.isSystem, true)))[0]!.id;
}

// The shared test database's system wallet carries an offset from direct inserts in schema tests, so the
// first time a wallet is checked its offset is recorded and every later check must keep it unchanged.
// Fresh user wallets start at zero, so for them this is an absolute check.
const baseline = new Map<string, bigint>();

/** Each wallet's balance must equal its ledger net (plus its fixed offset), and every transaction must net to zero. */
export async function assertLedgerConsistent(walletIds: string[]) {
  for (const id of walletIds) {
    const [row] = await db
      .select({ net: sql<string>`coalesce(sum(case when ${ledgerEntries.type} = 'CREDIT' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, id));
    const offset = (await balanceOf(id)) - BigInt(row!.net);
    if (!baseline.has(id)) baseline.set(id, offset);
    expect(offset).toBe(baseline.get(id));
  }
  const unbalanced = await db.execute(sql`
    select transaction_id from ledger_entries group by transaction_id
    having sum(case when type = 'CREDIT' then amount else -amount end) <> 0`);
  expect(unbalanced.rows).toHaveLength(0);
}

/** A logged-in administrator (created directly in the database; there is no public way to become one). */
export async function newAdmin() {
  const email = `admin-${uniq()}@test.local`;
  const [u] = await db
    .insert(users)
    .values({ name: 'Admin', email, passwordHash: await hashPassword(PASSWORD), role: 'ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() })
    .returning();
  const b = browser();
  await b.init();
  expect((await b.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return { b, email, userId: u!.id };
}
