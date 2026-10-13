import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import { auditLogs, outboxEvents, refreshTokens, transactions, users, wallets } from '../../db/schema/index.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/token.service.js';
import { listTransactions } from '../transactions/transactions.service.js';
import { ADMIN_STATS_KEY } from './stats.service.js';

export const userListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
  wallet: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const userDto = (u: typeof users.$inferSelect, w: typeof wallets.$inferSelect | null) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
  emailVerified: u.emailVerifiedAt !== null,
  hasTransactionPin: u.transactionPinHash !== null,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
  wallet: w ? { id: w.id, balance: w.balance, status: w.status, freezeReason: w.freezeReason, frozenAt: w.frozenAt, frozenBy: w.frozenBy } : null,
});

export async function listUsers(q: z.infer<typeof userListQuery>) {
  const filters: (SQL | undefined)[] = [];
  if (q.status) filters.push(eq(users.status, q.status));
  if (q.role) filters.push(eq(users.role, q.role));
  if (q.wallet) filters.push(eq(wallets.status, q.wallet));
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    filters.push(or(ilike(users.name, like), ilike(users.email, like)));
  }
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    filters.push(sql`(${users.createdAt}, ${users.id}) < (${ts}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db
    .select({ u: users, w: wallets, ts: sql<string>`${users.createdAt}::text` })
    .from(users)
    .leftJoin(wallets, eq(wallets.userId, users.id))
    .where(and(...filters))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => userDto(r.u, r.w)), nextCursor: rows.length > q.limit && last ? encodeCursor(last.ts, last.u.id) : null };
}

/** Everything an admin needs to investigate one account. Viewing a user's data is itself audited. */
export async function getUserDetail(req: Request, adminId: string, id: string) {
  const [row] = await db.select({ u: users, w: wallets }).from(users).leftJoin(wallets, eq(wallets.userId, users.id)).where(eq(users.id, id));
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', 'User not found');

  const [sessions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, id), sql`${refreshTokens.revokedAt} IS NULL`, sql`${refreshTokens.expiresAt} > now()`));
  const recentTransactions = row.w ? (await listTransactions(id, { limit: 10 })).items : [];
  const recentAudit = await db
    .select()
    .from(auditLogs)
    .where(or(eq(auditLogs.userId, id), eq(auditLogs.targetUserId, id)))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(10);
  const [failed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(row.w ? eq(transactions.senderWalletId, row.w.id) : sql`false`, eq(transactions.status, 'FAILED')));

  await audit(req, { action: 'ADMIN_VIEWED_USER', userId: adminId, targetUserId: id });
  return {
    user: userDto(row.u, row.w),
    activeSessions: sessions?.n ?? 0,
    failedTransactions: failed?.n ?? 0,
    recentTransactions,
    recentAudit: recentAudit.map((a) => ({ id: a.id, action: a.action, severity: a.severity, createdAt: a.createdAt, metadata: a.metadata })),
  };
}

/**
 * Freezes a user's wallet. The wallet row is locked and updated inside the transaction, and every money path re-checks
 * wallet status under that same row lock, so the freeze takes effect immediately, even for payments already in flight:
 * a payment that locked the wallet first completes before the freeze; any payment after it is refused.
 */
export async function freezeUser(req: Request, adminId: string, userId: string, reason: string) {
  if (userId === adminId) throw new AppError('FORBIDDEN', 'You cannot freeze your own account');
  await withTransaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, userId));
    if (!target) throw new AppError('RESOURCE_NOT_FOUND', 'User not found');
    if (target.role === 'ADMIN') throw new AppError('FORBIDDEN', 'Administrator accounts cannot be frozen');
    const [w] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for('update');
    if (!w) throw new AppError('RESOURCE_NOT_FOUND', 'This user has no wallet yet');
    if (w.status === 'FROZEN') throw new AppError('VALIDATION_ERROR', 'This wallet is already frozen');
    if (w.status === 'CLOSED') throw new AppError('VALIDATION_ERROR', 'This wallet is closed');

    await tx
      .update(wallets)
      // clock_timestamp() is evaluated after the row lock is acquired, so frozen_at is the true moment of the freeze.
      .set({ status: 'FROZEN', freezeReason: reason, frozenAt: sql`clock_timestamp()`, frozenBy: adminId, version: sql`${wallets.version} + 1`, updatedAt: new Date() })
      .where(eq(wallets.id, w.id));
    await tx.insert(outboxEvents).values({ aggregateType: 'user', aggregateId: userId, eventType: 'ACCOUNT_FROZEN', payload: { userId, reason } });
    await audit(req, { action: 'ACCOUNT_FROZEN', userId: adminId, targetUserId: userId, severity: 'CRITICAL', entityType: 'wallet', entityId: w.id, metadata: { reason } }, tx);
  });
  await Promise.all([invalidate(cacheKeys.user(userId), ADMIN_STATS_KEY)]);
  return getUserSummary(userId);
}

export async function unfreezeUser(req: Request, adminId: string, userId: string) {
  await withTransaction(async (tx) => {
    const [w] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for('update');
    if (!w) throw new AppError('RESOURCE_NOT_FOUND', 'User or wallet not found');
    if (w.status !== 'FROZEN') throw new AppError('VALIDATION_ERROR', 'This wallet is not frozen');
    await tx
      .update(wallets)
      .set({ status: 'ACTIVE', freezeReason: null, frozenAt: null, frozenBy: null, version: sql`${wallets.version} + 1`, updatedAt: new Date() })
      .where(eq(wallets.id, w.id));
    await tx.insert(outboxEvents).values({ aggregateType: 'user', aggregateId: userId, eventType: 'ACCOUNT_UNFROZEN', payload: { userId } });
    await audit(req, { action: 'ACCOUNT_UNFROZEN', userId: adminId, targetUserId: userId, severity: 'WARN', entityType: 'wallet', entityId: w.id, metadata: { previousReason: w.freezeReason } }, tx);
  });
  await Promise.all([invalidate(cacheKeys.user(userId), ADMIN_STATS_KEY)]);
  return getUserSummary(userId);
}

/** Signs the user out of every device. Their next refresh fails; an access token lives at most 15 more minutes. */
export async function forceLogout(req: Request, adminId: string, userId: string) {
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!target) throw new AppError('RESOURCE_NOT_FOUND', 'User not found');
  await revokeAllSessions(userId);
  await audit(req, { action: 'FORCE_LOGOUT', userId: adminId, targetUserId: userId, severity: 'WARN' });
}

async function getUserSummary(userId: string) {
  const [row] = await db.select({ u: users, w: wallets }).from(users).leftJoin(wallets, eq(wallets.userId, users.id)).where(eq(users.id, userId));
  return userDto(row!.u, row!.w);
}
