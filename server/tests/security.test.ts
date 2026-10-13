import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/client.js';
import { sentMail } from '../src/lib/mailer.js';
import { closeRedis, getRedis } from '../src/redis/client.js';
import { balanceOf, ensureSystemWallet, fund, newUser, PASSWORD, PIN, send } from './helpers.js';

beforeAll(async () => {
  await ensureSystemWallet();
});
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

const resetToken = (email: string) => {
  const mail = [...sentMail].reverse().find((m) => m.to === email && /Reset your CoinHub transaction PIN/.test(m.subject));
  return /token=([\w-]+)/.exec(mail?.text ?? '')?.[1];
};

describe('forgot PIN', () => {
  it('needs the account password, emails a single-use link, and sets the new PIN', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    const wrong = await a.b.post('/api/v1/users/me/pin/reset-request', { password: 'Wrong-Passw0rd' });
    expect(wrong.status).toBe(401);
    expect(resetToken(a.email)).toBeUndefined(); // no email for a wrong password

    expect((await a.b.post('/api/v1/users/me/pin/reset-request', { password: PASSWORD })).status).toBe(202);
    const token = resetToken(a.email)!;
    expect(token).toBeTruthy();
    expect((await a.b.post('/api/v1/users/me/pin/reset', { token, newPin: '1234' })).status).toBe(400); // weak PIN
    const ok = await a.b.post('/api/v1/users/me/pin/reset', { token, newPin: '9753' });
    expect(ok.status).toBe(200);
    expect((await a.b.post('/api/v1/users/me/pin/reset', { token, newPin: '8642' })).status).toBe(400); // single use

    expect((await send(a, b, 10_000, { pin: PIN })).status).toBe(401); // old PIN no longer works
    await getRedis().del(`pin:attempts:${a.userId}`);
    expect((await send(a, b, 10_000, { pin: '9753' })).status).toBe(201);
    expect(await balanceOf(b.walletId)).toBe(10_000n);
    expect(sentMail.some((m) => m.to === a.email && /PIN was reset/.test(m.subject))).toBe(true);
  });

  it('clears a PIN lockout', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 100_000);
    for (const pin of ['1111', '2222', '3333']) await send(a, b, 1_000, { pin });
    expect((await send(a, b, 1_000, { pin: PIN })).body.error.code).toBe('PIN_LOCKED');
    await a.b.post('/api/v1/users/me/pin/reset-request', { password: PASSWORD });
    expect((await a.b.post('/api/v1/users/me/pin/reset', { token: resetToken(a.email), newPin: '9753' })).status).toBe(200);
    expect((await send(a, b, 1_000, { pin: '9753' })).status).toBe(201);
  });

  it("a token cannot be used by a different user's session", async () => {
    const [a, other] = [await newUser(), await newUser()];
    await a.b.post('/api/v1/users/me/pin/reset-request', { password: PASSWORD });
    const token = resetToken(a.email)!;
    expect((await other.b.post('/api/v1/users/me/pin/reset', { token, newPin: '9753' })).status).toBe(400);
    expect((await a.b.post('/api/v1/users/me/pin/reset', { token, newPin: '9753' })).status).toBe(400); // the failed attempt consumed it
  });
});
