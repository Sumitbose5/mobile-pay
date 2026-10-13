import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDb, db } from '../src/db/client.js';
import { auditLogs, refreshTokens, users, wallets } from '../src/db/schema/index.js';
import { sha256 } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';
import { sentMail } from '../src/lib/mailer.js';
import { closeRedis } from '../src/redis/client.js';

const app = createApp();
const PASSWORD = 'Str0ngPassw0rd';
const uniq = () => Math.random().toString(36).slice(2, 10);
const newEmail = () => `user-${uniq()}@test.local`;

/** A browser-like client: cookie jar + automatic CSRF header, like the SPA's axios instance. */
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
  return {
    agent,
    init: async () => sync(await agent.get('/api/v1/auth/csrf')),
    get: async (p: string) => sync(await agent.get(p)),
    post: async (p: string, body?: object) => sync(await agent.post(p).set('x-csrf-token', csrf).send(body)),
    patch: async (p: string, body?: object) => sync(await agent.patch(p).set('x-csrf-token', csrf).send(body)),
    del: async (p: string) => sync(await agent.delete(p).set('x-csrf-token', csrf)),
  };
}

/** Reads a cookie value out of a browser()'s jar (to hand-build replay/race requests). */
const cookieFrom = (b: ReturnType<typeof browser>, name: string): string => {
  const jar = b.agent.jar.getCookies({ domain: '127.0.0.1', path: '/api/v1/auth', secure: false, script: false });
  const value = jar.find((c) => c.name === name)?.value;
  if (!value) throw new Error(`cookie ${name} not in jar`);
  return value;
};

const tokenFor = (to: string, subject: RegExp) => {
  const mail = [...sentMail].reverse().find((m) => m.to === to && subject.test(m.subject));
  return /token=([\w-]+)/.exec(mail?.text ?? '')?.[1];
};

async function registerVerified(email = newEmail()) {
  const b = browser();
  await b.init();
  expect((await b.post('/api/v1/auth/register', { name: 'Test User', email, password: PASSWORD })).status).toBe(202);
  const token = tokenFor(email, /Verify/);
  expect(token).toBeTruthy();
  expect((await b.post('/api/v1/auth/verify-email', { token })).status).toBe(200);
  return { b, email };
}

async function loggedIn() {
  const { b, email } = await registerVerified();
  const res = await b.post('/api/v1/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { b, email, res };
}

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe('registration and verification', () => {
  it('registers, blocks login until verified, then creates a wallet on verification', async () => {
    const email = newEmail();
    const b = browser();
    await b.init();
    expect((await b.post('/api/v1/auth/register', { name: 'Asha', email, password: PASSWORD })).status).toBe(202);

    const early = await b.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const [before] = await db.select().from(users).where(eq(users.email, email));
    expect(before?.status).toBe('PENDING_VERIFICATION');
    expect(await db.select().from(wallets).where(eq(wallets.userId, before!.id))).toHaveLength(0);

    const token = tokenFor(email, /Verify/)!;
    expect((await b.post('/api/v1/auth/verify-email', { token })).status).toBe(200);
    expect((await b.post('/api/v1/auth/verify-email', { token })).status).toBe(400); // single use

    const [after] = await db.select().from(users).where(eq(users.email, email));
    expect(after?.status).toBe('ACTIVE');
    const w = await db.select().from(wallets).where(eq(wallets.userId, after!.id));
    expect(w).toHaveLength(1);
    expect(w[0]?.balance).toBe(0n);
  });

  it('does not reveal whether an email is already registered', async () => {
    const { email } = await registerVerified();
    const b = browser();
    await b.init();
    const res = await b.post('/api/v1/auth/register', { name: 'Someone', email, password: PASSWORD });
    expect(res.status).toBe(202);
    expect(sentMail.some((m) => m.to === email && /already have/.test(m.subject))).toBe(true);
  });

  it('rejects weak passwords and bad input with VALIDATION_ERROR', async () => {
    const b = browser();
    await b.init();
    const res = await b.post('/api/v1/auth/register', { name: 'A', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stores only a hash of the password', async () => {
    const { email } = await registerVerified();
    const [u] = await db.select().from(users).where(eq(users.email, email));
    expect(u?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('login, cookies and CSRF', () => {
  it('sets HttpOnly auth cookies and never returns tokens in the body', async () => {
    const { res } = await loggedIn();
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('access_token='))!;
    const refresh = cookies.find((c) => c.startsWith('refresh_token='))!;
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { email } = await registerVerified();
    const b = browser();
    await b.init();
    const wrong = await b.post('/api/v1/auth/login', { email, password: 'Wrong-Passw0rd' });
    const unknown = await b.post('/api/v1/auth/login', { email: newEmail(), password: 'Wrong-Passw0rd' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects state-changing requests without a valid CSRF token', async () => {
    const { b } = await loggedIn();
    const noHeader = await b.agent.post('/api/v1/auth/logout');
    expect(noHeader.status).toBe(403);
    const forged = await b.agent.post('/api/v1/auth/logout').set('x-csrf-token', 'forged.value');
    expect(forged.status).toBe(403);
  });

  it('protects authenticated routes', async () => {
    const anon = browser();
    expect((await anon.get('/api/v1/users/me')).status).toBe(401);
    const { b, email } = await loggedIn();
    const me = await b.get('/api/v1/users/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rate limits repeated failed logins (5 per window) and records them in the audit log', async () => {
    const { email } = await registerVerified();
    const b = browser();
    await b.init();
    for (let i = 0; i < 5; i++) {
      expect((await b.post('/api/v1/auth/login', { email, password: 'Wrong-Passw0rd' })).status).toBe(401);
    }
    const blocked = await b.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const failures = await db.select().from(auditLogs).where(eq(auditLogs.userId, u!.id));
    expect(failures.filter((l) => l.action === 'LOGIN_FAILED').length).toBeGreaterThanOrEqual(5);
  });
});

describe('refresh-token rotation', () => {
  it('rotates the refresh token on every refresh', async () => {
    const { b, email } = await loggedIn();
    expect((await b.post('/api/v1/auth/refresh')).status).toBe(200);
    expect((await b.post('/api/v1/auth/refresh')).status).toBe(200);
    expect((await b.get('/api/v1/users/me')).status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, u!.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('revokes the whole family when an old token is replayed after the grace window', async () => {
    const { b, email } = await loggedIn();
    const oldRefresh = cookieFrom(b, 'refresh_token');
    expect((await b.post('/api/v1/auth/refresh')).status).toBe(200); // rotates: oldRefresh is now revoked

    // Age the revocation past the grace window so a replay looks like theft, not a racing tab.
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.tokenHash, sha256(oldRefresh)));

    const csrf = (await request(app).get('/api/v1/auth/csrf')).body.data.csrfToken as string;
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('x-csrf-token', csrf)
      .set('Cookie', [`refresh_token=${oldRefresh}`, `csrf_token=${csrf}`]);
    expect(replay.status).toBe(401);

    // The legitimate user's newest token is dead too: the whole family was revoked.
    expect((await b.post('/api/v1/auth/refresh')).status).toBe(401);
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.userId, u!.id));
    expect(logs.some((l) => l.action === 'REFRESH_TOKEN_REUSE_DETECTED' && l.severity === 'CRITICAL')).toBe(true);
  });

  it('lets exactly one of two racing refreshes win without killing the session', async () => {
    const { b } = await loggedIn();
    const refresh = cookieFrom(b, 'refresh_token');
    const csrf = cookieFrom(b, 'csrf_token');
    const send = () =>
      request(app)
        .post('/api/v1/auth/refresh')
        .set('x-csrf-token', csrf)
        .set('Cookie', [`refresh_token=${refresh}`, `csrf_token=${csrf}`]);
    const [r1, r2] = await Promise.all([send(), send()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    // Within the grace window the loser must not have revoked the winner's session.
    const winner = [r1, r2].find((r) => r.status === 200)!;
    const newRefresh = (winner.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!;
    const value = /refresh_token=([^;]+)/.exec(newRefresh)![1]!;
    const next = await request(app)
      .post('/api/v1/auth/refresh')
      .set('x-csrf-token', csrf)
      .set('Cookie', [`refresh_token=${value}`, `csrf_token=${csrf}`]);
    expect(next.status).toBe(200);
  });
});

describe('password reset and change', () => {
  it('resets the password with a single-use token and signs out every session', async () => {
    const { b, email } = await loggedIn();
    const anon = browser();
    await anon.init();
    expect((await anon.post('/api/v1/auth/forgot-password', { email })).status).toBe(202);
    const unknown = await anon.post('/api/v1/auth/forgot-password', { email: newEmail() });
    expect(unknown.status).toBe(202); // identical for unknown emails

    const token = tokenFor(email, /Reset/)!;
    const newPassword = 'Brand-New-Passw0rd';
    expect((await anon.post('/api/v1/auth/reset-password', { token, password: newPassword })).status).toBe(200);
    expect((await anon.post('/api/v1/auth/reset-password', { token, password: newPassword })).status).toBe(400);

    expect((await b.post('/api/v1/auth/refresh')).status).toBe(401); // old session is gone
    expect((await anon.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await anon.post('/api/v1/auth/login', { email, password: newPassword })).status).toBe(200);
    expect(sentMail.some((m) => m.to === email && /password was reset/.test(m.subject))).toBe(true);
  });

  it('changing the password keeps this session and signs out the others', async () => {
    const { b, email } = await loggedIn();
    const other = browser();
    await other.init();
    expect((await other.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);

    const wrong = await b.post('/api/v1/auth/change-password', { currentPassword: 'Nope-Passw0rd', newPassword: 'Another-Passw0rd' });
    expect(wrong.status).toBe(401);
    const ok = await b.post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Another-Passw0rd' });
    expect(ok.status).toBe(200);

    expect((await b.post('/api/v1/auth/refresh')).status).toBe(200);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('sessions and logout', () => {
  it('lists sessions, revokes another device, and logs out', async () => {
    const { b, email } = await loggedIn();
    const other = browser();
    await other.init();
    expect((await other.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);

    const list = await b.get('/api/v1/auth/sessions');
    expect(list.body.data.sessions).toHaveLength(2);
    const current = list.body.data.sessions.find((s: { current: boolean }) => s.current);
    const otherSession = list.body.data.sessions.find((s: { current: boolean }) => !s.current);
    expect(current).toBeTruthy();

    expect((await b.del(`/api/v1/auth/sessions/${otherSession.id}`)).status).toBe(200);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await b.del(`/api/v1/auth/sessions/${otherSession.id}`)).status).toBe(404);

    expect((await b.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await b.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('users and RBAC', () => {
  it('updates the profile and notification preferences', async () => {
    const { b } = await loggedIn();
    const patched = await b.patch('/api/v1/users/me', { name: 'New Name' });
    expect(patched.body.data.user.name).toBe('New Name');
    const prefs = await b.patch('/api/v1/users/me/notification-preferences', { emailMarketing: true });
    expect(prefs.body.data.preferences.emailMarketing).toBe(true);
    expect((await b.patch('/api/v1/users/me/notification-preferences', {})).status).toBe(400);
  });

  it('forbids regular users from admin routes and allows admins', async () => {
    const { b } = await loggedIn();
    const denied = await b.get('/api/v1/admin/ping');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const email = newEmail();
    await db.insert(users).values({
      name: 'Admin',
      email,
      passwordHash: await hashPassword(PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const admin = browser();
    await admin.init();
    expect((await admin.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
    expect((await admin.get('/api/v1/admin/ping')).status).toBe(200);
  });
});
