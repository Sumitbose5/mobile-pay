import type { Request, RequestHandler } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { isTest } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { getRedis } from '../redis/client.js';

interface LimiterOptions {
  name: string;
  windowMs: number;
  limit: number;
  /** Extra key material besides the client IP (e.g. the email being attacked). */
  keyBy?: (req: Request) => string | undefined;
  /** Only failed responses (status >= 400) count toward the limit. */
  countFailuresOnly?: boolean;
}

/** Redis-backed so limits are shared across API instances; in-memory under test. */
export function createLimiter(opts: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: opts.countFailuresOnly ?? false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}:${opts.keyBy?.(req) ?? ''}`,
    store: isTest
      ? undefined
      : new RedisStore({
          prefix: `rl:${opts.name}:`,
          sendCommand: (command: string, ...args: string[]) =>
            getRedis().call(command, ...args) as Promise<never>,
        }),
    handler: (_req, _res, next) =>
      next(new AppError('RATE_LIMITED', 'Too many requests. Please try again later.')),
  });
}

const emailOf = (req: Request): string | undefined =>
  typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : undefined;

// Under test only the login limiter keeps its real limit; the others are relaxed so suites can create many users.
const relaxed = (limit: number) => (isTest ? 100_000 : limit);

export const limiters = {
  global: () => createLimiter({ name: 'global', windowMs: 60_000, limit: relaxed(100) }),
  register: () => createLimiter({ name: 'register', windowMs: 60 * 60_000, limit: relaxed(10) }),
  login: () =>
    createLimiter({ name: 'login', windowMs: 15 * 60_000, limit: 5, keyBy: emailOf, countFailuresOnly: true }),
  forgotPassword: () => createLimiter({ name: 'forgot', windowMs: 60 * 60_000, limit: 3, keyBy: emailOf }),
  resendVerification: () => createLimiter({ name: 'resend', windowMs: 60 * 60_000, limit: 3, keyBy: emailOf }),
  // Keyed per user (the router authenticates first), so shared IPs do not block each other.
  addMoney: () =>
    createLimiter({ name: 'add-money', windowMs: 60_000, limit: relaxed(5), keyBy: (req) => req.auth?.userId }),
  send: () => createLimiter({ name: 'send', windowMs: 60_000, limit: relaxed(10), keyBy: (req) => req.auth?.userId }),
  withdraw: () => createLimiter({ name: 'withdraw', windowMs: 60_000, limit: relaxed(5), keyBy: (req) => req.auth?.userId }),
  export: () => createLimiter({ name: 'export', windowMs: 60_000, limit: relaxed(3), keyBy: (req) => req.auth?.userId }),
  lookup: () => createLimiter({ name: 'lookup', windowMs: 60_000, limit: relaxed(20), keyBy: (req) => req.auth?.userId }),
  resetPassword: () => createLimiter({ name: 'reset', windowMs: 15 * 60_000, limit: 10 }),
};
