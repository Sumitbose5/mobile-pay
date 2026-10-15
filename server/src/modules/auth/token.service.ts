import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { CookieOptions } from 'express';
import { env, isProd } from '../../config/env.js';
import { db } from '../../db/client.js';
import { refreshTokens, users } from '../../db/schema/index.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { ACCESS_COOKIE, signAccessToken } from '../../middleware/authenticate.js';
import { issueCsrfToken } from '../../middleware/csrf.js';
import { mails, sendMail } from '../../lib/mailer.js';
import { audit } from '../audit/audit.service.js';

export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/v1/auth';
/** A just-rotated token presented again within this window is a racing tab, not theft. */
const REUSE_GRACE_MS = 10_000;

const baseCookie: CookieOptions = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' };
const refreshTtlMs = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

interface SessionUser {
  id: string;
  role: 'USER' | 'ADMIN';
}

function setAuthCookies(res: Response, user: SessionUser, familyId: string, refreshRaw: string): void {
  res.cookie(ACCESS_COOKIE, signAccessToken({ userId: user.id, role: user.role, familyId }), {
    ...baseCookie,
    path: '/',
    maxAge: env.ACCESS_TOKEN_TTL_MIN * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshRaw, { ...baseCookie, path: REFRESH_PATH, maxAge: refreshTtlMs() });
  issueCsrfToken(res);
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: REFRESH_PATH });
}

/** Starts a new login session (a new refresh-token family). */
export async function startSession(req: Request, res: Response, user: SessionUser): Promise<void> {
  const familyId = randomUUID();
  const raw = randomToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    familyId,
    tokenHash: sha256(raw),
    deviceInfo: req.get('user-agent')?.slice(0, 300) ?? null,
    ipAddress: req.ip ?? null,
    expiresAt: new Date(Date.now() + refreshTtlMs()),
    lastUsedAt: new Date(),
  });
  setAuthCookies(res, user, familyId, raw);
}

/** Rotates the refresh token. Presenting an already-rotated token revokes the whole family. */
export async function rotateSession(req: Request, res: Response): Promise<{ userId: string }> {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!raw) throw new AppError('UNAUTHORIZED', 'Authentication required');

  const [token] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(raw))).limit(1);
  if (!token) {
    clearAuthCookies(res);
    throw new AppError('UNAUTHORIZED', 'Session expired. Please log in again.');
  }

  if (token.revokedAt) {
    const withinGrace = Date.now() - token.revokedAt.getTime() < REUSE_GRACE_MS && token.replacedBy;
    if (!withinGrace) {
      await revokeFamily(token.familyId);
      await audit(req, {
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        userId: token.userId,
        severity: 'CRITICAL',
        metadata: { familyId: token.familyId },
      });
      const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, token.userId));
      if (owner) void sendMail(mails.security(owner.email, 'Your session was ended because of suspicious activity'));
    }
    clearAuthCookies(res);
    throw new AppError('UNAUTHORIZED', 'Session expired. Please log in again.');
  }

  if (token.expiresAt <= new Date()) {
    clearAuthCookies(res);
    throw new AppError('UNAUTHORIZED', 'Session expired. Please log in again.');
  }

  const [user] = await db.select().from(users).where(eq(users.id, token.userId)).limit(1);
  if (!user || user.status !== 'ACTIVE') {
    await revokeFamily(token.familyId);
    clearAuthCookies(res);
    throw new AppError('UNAUTHORIZED', 'Session expired. Please log in again.');
  }

  const newRaw = randomToken();
  const newId = randomUUID();
  const rotated = await db.transaction(async (tx) => {
    // Conditional update: of two racing requests only one wins the revocation.
    const claimed = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedBy: newId })
      .where(and(eq(refreshTokens.id, token.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    if (claimed.length === 0) return false;
    await tx.insert(refreshTokens).values({
      id: newId,
      userId: token.userId,
      familyId: token.familyId,
      tokenHash: sha256(newRaw),
      deviceInfo: req.get('user-agent')?.slice(0, 300) ?? token.deviceInfo,
      ipAddress: req.ip ?? null,
      expiresAt: new Date(Date.now() + refreshTtlMs()),
      lastUsedAt: new Date(),
    });
    return true;
  });
  if (!rotated) throw new AppError('UNAUTHORIZED', 'Session expired. Please log in again.');

  setAuthCookies(res, { id: user.id, role: user.role }, token.familyId, newRaw);
  return { userId: user.id };
}

export async function revokeFamily(familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: sql`coalesce(${refreshTokens.revokedAt}, now())` })
    .where(eq(refreshTokens.familyId, familyId));
}

/** Revokes every session of a user, optionally keeping one (e.g. the one changing the password). */
export async function revokeAllSessions(userId: string, exceptFamilyId?: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: sql`coalesce(${refreshTokens.revokedAt}, now())` })
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        exceptFamilyId ? ne(refreshTokens.familyId, exceptFamilyId) : undefined,
      ),
    );
}

export async function listActiveSessions(userId: string) {
  return db
    .select({
      id: refreshTokens.familyId,
      device: refreshTokens.deviceInfo,
      ip: refreshTokens.ipAddress,
      lastUsedAt: refreshTokens.lastUsedAt,
      createdAt: refreshTokens.createdAt,
    })
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())),
    )
    .orderBy(sql`${refreshTokens.lastUsedAt} desc nulls last`);
}
