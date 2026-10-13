import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getNumber } from '../modules/settings/settings.service.js';

const KEY_FORMAT = /^[A-Za-z0-9_-]{16,100}$/;
/** An IN_PROGRESS row older than this is a crashed request; the key may be taken over. */
const STALE_MS = 2 * 60_000;

declare module 'express-serve-static-core' {
  interface Request {
    idempotencyKeyId?: string;
  }
}

const stableStringify = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => {
    if (typeof val === 'bigint') return val.toString(); // validated bodies carry bigint paise
    return val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val;
  });

/**
 * Makes a POST safe to retry. Requires an `Idempotency-Key` header (>=16 chars, e.g. a UUID).
 * - new key           -> run the handler once and store its response
 * - same key + body   -> replay the stored response (no second side effect)
 * - same key, running -> 409 REQUEST_IN_PROGRESS
 * - same key, other body -> 422 IDEMPOTENCY_KEY_REUSED
 * The unique (user, key, endpoint) index is what makes parallel duplicates safe.
 * Must be mounted after `authenticate` and body parsing.
 */
export const idempotent =
  (endpoint: string, opts: { ignoreFields?: string[] } = {}): RequestHandler =>
  async (req, res, next) => {
    try {
      const userId = req.auth?.userId;
      if (!userId) throw new AppError('UNAUTHORIZED', 'Authentication required');
      const key = req.get('idempotency-key');
      if (!key || !KEY_FORMAT.test(key)) {
        throw new AppError('VALIDATION_ERROR', 'A valid Idempotency-Key header is required');
      }
      // Secrets (e.g. a PIN) are excluded: a 4-digit value hashed here would be trivially brute-forceable.
      const hashed = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => !opts.ignoreFields?.includes(k)));
      const requestHash = sha256(`${req.method} ${req.originalUrl}\n${stableStringify(hashed)}`);
      const ttlHours = await getNumber('idempotency.ttl_hours');
      const expiresAt = new Date(Date.now() + Number(ttlHours) * 3_600_000);

      const claim = () =>
        db
          .insert(idempotencyKeys)
          .values({ userId, key, endpoint, requestHash, expiresAt })
          .onConflictDoNothing()
          .returning();
      let [row] = await claim();

      if (!row) {
        const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key), eq(idempotencyKeys.endpoint, endpoint));
        const [existing] = await db.select().from(idempotencyKeys).where(where).limit(1);
        if (!existing) throw new AppError('REQUEST_IN_PROGRESS', 'Request is already being processed');
        if (existing.requestHash !== requestHash) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
        }
        if (existing.status === 'COMPLETED') {
          res.setHeader('Idempotent-Replayed', 'true');
          return void res.status(existing.responseStatus ?? 200).json(existing.responseBody);
        }
        if (Date.now() - existing.createdAt.getTime() < STALE_MS) {
          throw new AppError('REQUEST_IN_PROGRESS', 'Request is already being processed');
        }
        // Stale: the original attempt died. Take the key over (only one racer wins the delete).
        const taken = await db.delete(idempotencyKeys).where(and(where, eq(idempotencyKeys.id, existing.id))).returning();
        if (taken.length === 0) throw new AppError('REQUEST_IN_PROGRESS', 'Request is already being processed');
        [row] = await claim();
        if (!row) throw new AppError('REQUEST_IN_PROGRESS', 'Request is already being processed');
      }

      req.idempotencyKeyId = row.id;
      const rowId = row.id;
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const status = res.statusCode;
        // Only successful outcomes are remembered. A failed attempt (wrong PIN, insufficient balance, 5xx)
        // releases the key so the client can fix the problem and retry. Nothing moved, so nothing can duplicate.
        const save =
          status >= 300
            ? db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, rowId))
            : db
                .update(idempotencyKeys)
                .set({
                  status: 'COMPLETED',
                  responseStatus: status,
                  // round-trip through JSON so bigint values are stored as the strings the client saw
                  responseBody: JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
                  completedAt: new Date(),
                })
                .where(eq(idempotencyKeys.id, rowId));
        // Persist before replying so an immediate retry always sees the stored response.
        save.then(
          () => originalJson(body),
          (err) => {
            logger.error({ err }, 'Failed to persist idempotent response');
            originalJson(body);
          },
        );
        return res;
      };
      next();
    } catch (err) {
      next(err);
    }
  };
