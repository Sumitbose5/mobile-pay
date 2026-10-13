import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { mails, sendMail } from '../../lib/mailer.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { getRedis } from '../../redis/client.js';
import { audit } from '../audit/audit.service.js';

const MAX_ATTEMPTS = 3;
const LOCK_SECONDS = 30 * 60;
const attemptsKey = (id: string) => `pin:attempts:${id}`;
const lockKey = (id: string) => `pin:lock:${id}`;

const isWeak = (pin: string): boolean => {
  if (/^(\d)\1+$/.test(pin)) return true; // 0000, 111111
  const asc = '0123456789';
  return asc.includes(pin) || [...asc].reverse().join('').includes(pin); // 1234, 4321
};

export const pinSchema = z
  .string()
  .regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits')
  .refine((p) => !isWeak(p), 'Choose a less predictable PIN');

async function getUser(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new AppError('UNAUTHORIZED', 'Authentication required');
  return u;
}

/** First-time PIN setup. Requires the account password so a stolen session cannot set its own PIN. */
export async function setPin(req: Request, userId: string, password: string, pin: string): Promise<void> {
  const user = await getUser(userId);
  if (user.transactionPinHash) throw new AppError('VALIDATION_ERROR', 'A PIN is already set. Use the change PIN option.');
  if (!(await verifyPassword(user.passwordHash, password))) {
    await audit(req, { action: 'PIN_SET_FAILED', userId, severity: 'WARN' });
    throw new AppError('INVALID_CREDENTIALS', 'Password is incorrect');
  }
  await db
    .update(users)
    .set({ transactionPinHash: await hashPassword(pin), pinSetAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
  await invalidate(cacheKeys.user(userId));
  await audit(req, { action: 'PIN_SET', userId, severity: 'WARN' });
  void sendMail(mails.security(user.email, 'A transaction PIN was set on your account'));
}

/** Verifies a PIN with brute-force protection: 3 wrong attempts lock PIN entry for 30 minutes. */
export async function verifyPin(req: Request, userId: string, pin: string): Promise<void> {
  const redis = getRedis();
  if (await redis.exists(lockKey(userId))) {
    throw new AppError('PIN_LOCKED', 'Too many wrong PIN attempts. Try again in 30 minutes.');
  }
  const user = await getUser(userId);
  if (!user.transactionPinHash) throw new AppError('PIN_NOT_SET', 'Set a transaction PIN first');

  if (await verifyPassword(user.transactionPinHash, pin)) {
    await redis.del(attemptsKey(userId));
    return;
  }

  const attempts = await redis.incr(attemptsKey(userId)); // atomic across parallel requests
  if (attempts === 1) await redis.expire(attemptsKey(userId), LOCK_SECONDS);
  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(lockKey(userId), '1', 'EX', LOCK_SECONDS);
    await redis.del(attemptsKey(userId));
    await audit(req, { action: 'PIN_LOCKED', userId, severity: 'CRITICAL' });
    void sendMail(mails.security(user.email, 'Your transaction PIN was locked after repeated wrong attempts'));
    throw new AppError('PIN_LOCKED', 'Too many wrong PIN attempts. Try again in 30 minutes.');
  }
  await audit(req, { action: 'PIN_VERIFY_FAILED', userId, severity: 'WARN', metadata: { attempts } });
  throw new AppError('INVALID_PIN', `Incorrect PIN. ${MAX_ATTEMPTS - attempts} attempt(s) left.`);
}

export async function changePin(req: Request, userId: string, currentPin: string, newPin: string): Promise<void> {
  await verifyPin(req, userId, currentPin);
  if (currentPin === newPin) throw new AppError('VALIDATION_ERROR', 'New PIN must be different');
  const user = await getUser(userId);
  await db
    .update(users)
    .set({ transactionPinHash: await hashPassword(newPin), pinSetAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
  await audit(req, { action: 'PIN_CHANGED', userId, severity: 'WARN' });
  void sendMail(mails.security(user.email, 'Your transaction PIN was changed'));
}

export async function requirePinSet(userId: string): Promise<void> {
  const user = await getUser(userId);
  if (!user.transactionPinHash) throw new AppError('PIN_NOT_SET', 'Set a transaction PIN before moving money');
}

const PIN_RESET_TTL_S = 30 * 60;
const pinResetKey = (token: string) => `pinreset:${sha256(token)}`;

/**
 * Forgot-PIN, step 1. Needs a logged-in session AND the account password, so a stolen session alone cannot take over
 * the PIN. The emailed single-use link (30 minutes) proves control of the mailbox as well.
 */
export async function requestPinReset(req: Request, userId: string, password: string): Promise<void> {
  const user = await getUser(userId);
  if (!(await verifyPassword(user.passwordHash, password))) {
    await audit(req, { action: 'PIN_RESET_REQUEST_FAILED', userId, severity: 'WARN' });
    throw new AppError('INVALID_CREDENTIALS', 'Password is incorrect');
  }
  const token = randomToken();
  await getRedis().set(pinResetKey(token), userId, 'EX', PIN_RESET_TTL_S);
  void sendMail(mails.resetPin(user.email, token));
  await audit(req, { action: 'PIN_RESET_REQUESTED', userId, severity: 'WARN' });
}

/** Step 2: the token is single use and bound to the same user. A reset also clears any PIN lockout. */
export async function resetPin(req: Request, userId: string, token: string, newPin: string): Promise<void> {
  const owner = await getRedis().getdel(pinResetKey(token));
  if (!owner || owner !== userId) throw new AppError('VALIDATION_ERROR', 'This PIN reset link is invalid or has expired');
  const user = await getUser(userId);
  await db
    .update(users)
    .set({ transactionPinHash: await hashPassword(newPin), pinSetAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
  await getRedis().del(attemptsKey(userId), lockKey(userId));
  await invalidate(cacheKeys.user(userId));
  await audit(req, { action: 'PIN_RESET_COMPLETED', userId, severity: 'WARN' });
  void sendMail(mails.security(user.email, 'Your transaction PIN was reset'));
}
