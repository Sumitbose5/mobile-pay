import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { auditLogs, beneficiaries, users } from '../src/db/schema/index.js';
import { closeRedis, getRedis } from '../src/redis/client.js';
import { browser, ensureSystemWallet, newUser, PIN, uniq } from './helpers.js';

beforeAll(async () => {
  await ensureSystemWallet();
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

const add = (u: Awaited<ReturnType<typeof newUser>>, email: string, extra: Record<string, unknown> = {}) =>
  u.b.post('/api/v1/beneficiaries', { email, pin: PIN, ...extra });

describe('beneficiaries', () => {
  it('adds with the PIN, lists with names, renames, removes, and can add again after removal', async () => {
    const [a, b] = [await newUser(), await newUser({ name: 'Rahul Sharma' })];
    const created = await add(a, b.email, { nickname: 'Rahul' });
    expect(created.status).toBe(201);
    expect(created.body.data.beneficiary).toMatchObject({ nickname: 'Rahul', user: { name: 'Rahul Sharma', email: b.email } });

    const list = await a.b.get('/api/v1/beneficiaries');
    expect(list.body.data.beneficiaries).toHaveLength(1);
    const id = created.body.data.beneficiary.id as string;

    const renamed = await a.b.patch(`/api/v1/beneficiaries/${id}`, { nickname: 'Rahul (rent)' });
    expect(renamed.body.data.beneficiary.nickname).toBe('Rahul (rent)');
    expect((await a.b.patch(`/api/v1/beneficiaries/${id}`, { nickname: '' })).body.data.beneficiary.nickname).toBeNull();

    expect((await a.b.del(`/api/v1/beneficiaries/${id}`)).status).toBe(200);
    expect((await a.b.get('/api/v1/beneficiaries')).body.data.beneficiaries).toHaveLength(0);
    expect((await a.b.del(`/api/v1/beneficiaries/${id}`)).status).toBe(404);
    expect((await add(a, b.email)).status).toBe(201); // soft delete: the person can be added again
    const rows = await db.select().from(beneficiaries).where(eq(beneficiaries.ownerId, a.userId));
    expect(rows).toHaveLength(2); // the removed row is kept for the audit trail
  });

  it('requires the right PIN and records the change in the audit log', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const wrong = await add(a, b.email, { pin: '1357' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_PIN');
    expect((await a.b.get('/api/v1/beneficiaries')).body.data.beneficiaries).toHaveLength(0);
    await getRedis().del(`pin:attempts:${a.userId}`);
    expect((await add(a, b.email)).status).toBe(201);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.userId, a.userId));
    expect(logs.some((l) => l.action === 'BENEFICIARY_ADDED' && l.targetUserId === b.userId)).toBe(true);
  });

  it('rejects duplicates, yourself, strangers and bad input', async () => {
    const [a, b] = [await newUser(), await newUser()];
    expect((await add(a, b.email)).status).toBe(201);
    const dup = await add(a, b.email);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_EXISTS');
    expect((await add(a, a.email)).body.error.code).toBe('VALIDATION_ERROR');
    expect((await add(a, 'ghost@test.local')).status).toBe(404);
    expect((await add(a, 'not-an-email')).status).toBe(400);
  });

  it('parallel adds of the same person create exactly one beneficiary', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const results = await Promise.all(Array.from({ length: 6 }, () => add(a, b.email)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('caps a user at 50 beneficiaries', async () => {
    const [a, extra] = [await newUser(), await newUser()];
    const bulk = await db
      .insert(users)
      .values(Array.from({ length: 50 }, (_, i) => ({ name: `B${i}`, email: `bulk-${uniq()}-${i}@test.local`, passwordHash: 'x', status: 'ACTIVE' as const })))
      .returning({ id: users.id });
    await db.insert(beneficiaries).values(bulk.map((u) => ({ ownerId: a.userId, beneficiaryUserId: u.id })));
    const res = await add(a, extra.email);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it("keeps each user's list private and requires login", async () => {
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    const id = (await add(a, b.email)).body.data.beneficiary.id as string;
    expect((await c.b.get('/api/v1/beneficiaries')).body.data.beneficiaries).toHaveLength(0);
    expect((await c.b.patch(`/api/v1/beneficiaries/${id}`, { nickname: 'mine now' })).status).toBe(404);
    expect((await c.b.del(`/api/v1/beneficiaries/${id}`)).status).toBe(404);
    expect((await browser().get('/api/v1/beneficiaries')).status).toBe(401);
  });
});
