import { eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { db } from '../../db/client.js';
import { notificationPreferences, users, wallets } from '../../db/schema/index.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { mails, sendMail } from '../../lib/mailer.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password.js';
import { getRedis } from '../../redis/client.js';
import { audit } from '../audit/audit.service.js';
import { clearAuthCookies, listActiveSessions, revokeAllSessions, revokeFamily, rotateSession, startSession } from './token.service.js';

const VERIFY_TTL_S = 24 * 60 * 60;
const RESET_TTL_S = 30 * 60;
const verifyKey = (token: string) => `verify:${sha256(token)}`;
const resetKey = (token: string) => `reset:${sha256(token)}`;
const byEmail = (email: string) => eq(sql`lower(${users.email})`, email);

export type UserDto = ReturnType<typeof toUserDto>;
export function toUserDto(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerifiedAt !== null,
    hasTransactionPin: u.transactionPinHash !== null,
    createdAt: u.createdAt,
  };
}

async function sendVerification(user: { id: string; email: string; name: string }): Promise<void> {
  const token = randomToken();
  await getRedis().set(verifyKey(token), user.id, 'EX', VERIFY_TTL_S);
  void sendMail(mails.verifyEmail(user.email, user.name, token));
}

export async function register(req: Request, input: { name: string; email: string; password: string }): Promise<void> {
  const [existing] = await db.select({ id: users.id }).from(users).where(byEmail(input.email)).limit(1);
  if (existing) {
    // Same response either way (no account enumeration); the real owner is told by email.
    void sendMail(mails.alreadyRegistered(input.email));
    await audit(req, { action: 'REGISTER_DUPLICATE_EMAIL', userId: existing.id, metadata: { email: input.email } });
    return;
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const [user] = await db
      .insert(users)
      .values({ name: input.name, email: input.email, passwordHash })
      .returning();
    if (!user) throw new Error('insert failed');
    await sendVerification(user);
    await audit(req, { action: 'USER_REGISTERED', userId: user.id });
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') return void sendMail(mails.alreadyRegistered(input.email)); // lost a signup race
    throw err;
  }
}

export async function verifyEmail(req: Request, token: string): Promise<void> {
  const userId = await getRedis().getdel(verifyKey(token));
  if (!userId) throw new AppError('VALIDATION_ERROR', 'This verification link is invalid or has expired');

  // Activation and wallet creation commit together or not at all.
  const user = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ status: 'ACTIVE', emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new AppError('VALIDATION_ERROR', 'This verification link is invalid or has expired');
    await tx.insert(wallets).values({ userId }).onConflictDoNothing();
    await tx.insert(notificationPreferences).values({ userId }).onConflictDoNothing();
    return updated;
  });
  await invalidate(cacheKeys.user(user.id));
  await audit(req, { action: 'EMAIL_VERIFIED', userId: user.id });
}

export async function resendVerification(req: Request, email: string): Promise<void> {
  const [user] = await db.select().from(users).where(byEmail(email)).limit(1);
  if (user && user.status === 'PENDING_VERIFICATION') {
    await sendVerification(user);
    await audit(req, { action: 'VERIFICATION_RESENT', userId: user.id });
  }
}

export async function login(req: Request, res: Response, input: { email: string; password: string }): Promise<UserDto> {
  const [user] = await db.select().from(users).where(byEmail(input.email)).limit(1);
  if (!user) {
    await burnPasswordCheck(input.password);
    await audit(req, { action: 'LOGIN_FAILED', severity: 'WARN', metadata: { email: input.email, reason: 'unknown_email' } });
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await audit(req, { action: 'LOGIN_FAILED', userId: user.id, severity: 'WARN', metadata: { reason: 'bad_password' } });
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (user.status === 'PENDING_VERIFICATION') {
    throw new AppError('EMAIL_NOT_VERIFIED', 'Please verify your email before logging in');
  }
  if (user.status !== 'ACTIVE') {
    await audit(req, { action: 'LOGIN_BLOCKED', userId: user.id, severity: 'WARN', metadata: { status: user.status } });
    throw new AppError('FORBIDDEN', 'This account is unavailable. Contact support.');
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await startSession(req, res, { id: user.id, role: user.role });
  await audit(req, { action: 'LOGIN_SUCCESS', userId: user.id });
  return toUserDto(user);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  await rotateSession(req, res);
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.auth) {
    await revokeFamily(req.auth.familyId);
    await audit(req, { action: 'LOGOUT' });
  }
  clearAuthCookies(res);
}

export async function forgotPassword(req: Request, email: string): Promise<void> {
  const [user] = await db.select().from(users).where(byEmail(email)).limit(1);
  if (!user || user.status !== 'ACTIVE') return; // identical response for unknown/inactive emails
  const token = randomToken();
  await getRedis().set(resetKey(token), user.id, 'EX', RESET_TTL_S);
  void sendMail(mails.resetPassword(user.email, token));
  await audit(req, { action: 'PASSWORD_RESET_REQUESTED', userId: user.id });
}

export async function resetPassword(req: Request, token: string, password: string): Promise<void> {
  const userId = await getRedis().getdel(resetKey(token)); // single use
  if (!userId) throw new AppError('VALIDATION_ERROR', 'This reset link is invalid or has expired');
  const [user] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!user) throw new AppError('VALIDATION_ERROR', 'This reset link is invalid or has expired');
  await revokeAllSessions(user.id);
  await audit(req, { action: 'PASSWORD_RESET_COMPLETED', userId: user.id, severity: 'WARN' });
  void sendMail(mails.security(user.email, 'Your password was reset'));
}

export async function changePassword(
  req: Request,
  userId: string,
  familyId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    await audit(req, { action: 'PASSWORD_CHANGE_FAILED', userId, severity: 'WARN' });
    throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));
  await revokeAllSessions(userId, familyId); // sign out every other device
  await audit(req, { action: 'PASSWORD_CHANGED', userId, severity: 'WARN' });
  void sendMail(mails.security(user.email, 'Your password was changed'));
}

export async function sessions(userId: string, currentFamilyId: string) {
  const rows = await listActiveSessions(userId);
  return rows.map((s) => ({ ...s, current: s.id === currentFamilyId }));
}

export async function revokeSession(req: Request, userId: string, familyId: string): Promise<void> {
  const owned = (await listActiveSessions(userId)).some((s) => s.id === familyId);
  if (!owned) throw new AppError('RESOURCE_NOT_FOUND', 'Session not found');
  await revokeFamily(familyId);
  await audit(req, { action: 'SESSION_REVOKED', userId, metadata: { familyId } });
}
