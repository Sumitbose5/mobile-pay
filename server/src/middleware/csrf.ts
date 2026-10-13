import type { CookieOptions, RequestHandler, Response } from 'express';
import { env, isProd } from '../config/env.js';
import { createCsrfToken, safeEqual, verifyCsrfSignature } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Server-to-server callbacks authenticate with an HMAC signature, not cookies.
// Public endpoints that don't modify authenticated user state are exempt:
const EXEMPT_PREFIXES = ['/payments/webhook', '/auth/register', '/auth/verify-email', '/auth/resend-verification', '/auth/forgot-password', '/auth/reset-password'];

export const csrfCookieOptions: CookieOptions = {
  httpOnly: false, // the SPA must read it to echo it in the header
  sameSite: 'strict',
  secure: isProd,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export function issueCsrfToken(res: Response): string {
  const token = createCsrfToken(env.CSRF_SECRET);
  res.cookie(CSRF_COOKIE, token, csrfCookieOptions);
  return token;
}

/** Double-submit cookie: header must equal the cookie, and the token must carry a valid signature. */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header) || !verifyCsrfSignature(cookie, env.CSRF_SECRET)) {
    return next(new AppError('FORBIDDEN', 'Invalid or missing CSRF token'));
  }
  next();
};
