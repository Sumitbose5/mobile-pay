import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export const ACCESS_COOKIE = 'access_token';

export interface AuthContext {
  userId: string;
  role: 'USER' | 'ADMIN';
  /** Refresh-token family = the login session this access token belongs to. */
  familyId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const claims = z.object({
  sub: z.string().uuid(),
  role: z.enum(['USER', 'ADMIN']),
  fid: z.string().uuid(),
});

export function signAccessToken(ctx: AuthContext): string {
  return jwt.sign({ role: ctx.role, fid: ctx.familyId }, env.JWT_ACCESS_SECRET, {
    subject: ctx.userId,
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
    algorithm: 'HS256',
  });
}

export const authenticate: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
  try {
    const payload = claims.parse(jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }));
    req.auth = { userId: payload.sub, role: payload.role, familyId: payload.fid };
    next();
  } catch {
    next(new AppError('UNAUTHORIZED', 'Session expired or invalid'));
  }
};

export const requireRole =
  (role: 'ADMIN'): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
    if (req.auth.role !== role) return next(new AppError('FORBIDDEN', 'You do not have access to this resource'));
    next();
  };

/**
 * Admin gate that asks the database, not the token. Access tokens are verified statelessly and live 15 minutes, so
 * a demoted or suspended administrator would otherwise keep their powers until the token expired.
 */
export const requireActiveAdmin: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.auth) throw new AppError('UNAUTHORIZED', 'Authentication required');
    const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, req.auth.userId)).limit(1);
    if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'You do not have access to this resource');
    next();
  } catch (err) {
    next(err);
  }
};
