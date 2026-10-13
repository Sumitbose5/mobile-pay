import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { auditLogs, ledgerEntries, transactions, users, wallets } from '../../db/schema/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { AppError } from '../../lib/errors.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ------------------------------------------------------------------ transactions

export const txnQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED']).optional(),
  type: z.enum(['ADD_MONEY', 'TRANSFER', 'WITHDRAWAL', 'REVERSAL']).optional(),
  userId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minAmount: z.string().regex(/^\d{1,15}$/).optional(),
  maxAmount: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
export type TxnQuery = z.infer<typeof txnQuery>;

const sw = alias(wallets, 'sw');
const rw = alias(wallets, 'rw');
const su = alias(users, 'su');
const ru = alias(users, 'ru');

const selection = {
  t: transactions,
  senderName: su.name,
  senderEmail: su.email,
  receiverName: ru.name,
  receiverEmail: ru.email,
  senderIsSystem: sw.isSystem,
  receiverIsSystem: rw.isSystem,
  ts: sql<string>`${transactions.createdAt}::text`,
  micros: sql<string>`(extract(epoch from ${transactions.createdAt}) * 1000000)::bigint::text`,
};
type Row = {
  t: typeof transactions.$inferSelect;
  senderName: string | null; senderEmail: string | null; receiverName: string | null; receiverEmail: string | null;
  senderIsSystem: boolean; receiverIsSystem: boolean; ts: string; micros: string;
};

const party = (name: string | null, email: string | null, isSystem: boolean, walletId: string) => ({
  walletId,
  name: name ?? (isSystem ? 'CoinHub (platform wallet)' : null),
  email,
});

const toDto = (r: Row) => ({
  id: r.t.publicId,
  type: r.t.type,
  status: r.t.status,
  amount: r.t.amount,
  sender: party(r.senderName, r.senderEmail, r.senderIsSystem, r.t.senderWalletId),
  receiver: party(r.receiverName, r.receiverEmail, r.receiverIsSystem, r.t.receiverWalletId),
  note: r.t.note,
  failureCode: r.t.failureCode,
  failureReason: r.t.failureReason,
  referenceId: r.t.referenceId,
  requestId: r.t.requestId,
  createdAt: r.t.createdAt,
  completedAt: r.t.completedAt,
});

const base = () =>
  db
    .select(selection)
    .from(transactions)
    .innerJoin(sw, eq(sw.id, transactions.senderWalletId))
    .innerJoin(rw, eq(rw.id, transactions.receiverWalletId))
    .leftJoin(su, eq(su.id, sw.userId))
    .leftJoin(ru, eq(ru.id, rw.userId));

/**
 * Newest-first across every wallet. With no user filter it is one query served by the (created_at, id) index (or the
 * status/type variants). With a user filter it uses the same two-sided index-friendly merge as the user's own history.
 * Unlike a user's view, admins see every status, including other people's failed attempts.
 */
export async function adminListTransactions(q: TxnQuery) {
  const filters: (SQL | undefined)[] = [];
  if (q.status) filters.push(eq(transactions.status, q.status));
  if (q.type) filters.push(eq(transactions.type, q.type));
  if (q.from) filters.push(gte(transactions.createdAt, q.from));
  if (q.to) filters.push(lte(transactions.createdAt, q.to));
  if (q.minAmount) filters.push(gte(transactions.amount, BigInt(q.minAmount)));
  if (q.maxAmount) filters.push(lte(transactions.amount, BigInt(q.maxAmount)));
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    filters.push(or(ilike(transactions.publicId, like), ilike(transactions.note, like), ilike(transactions.referenceId, like), ilike(su.name, like), ilike(su.email, like), ilike(ru.name, like), ilike(ru.email, like)));
  }
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    filters.push(sql`(${transactions.createdAt}, ${transactions.id}) < (${ts}::timestamptz, ${id}::uuid)`);
  }

  const order = [desc(transactions.createdAt), desc(transactions.id)] as const;
  let rows: Row[];
  if (q.userId) {
    const [w] = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.userId, q.userId));
    if (!w) return { items: [], nextCursor: null };
    const sides = await Promise.all(
      [eq(transactions.senderWalletId, w.id), eq(transactions.receiverWalletId, w.id)].map((side) =>
        base().where(and(side, ...filters)).orderBy(...order).limit(q.limit + 1),
      ),
    );
    rows = sides.flat().sort((x, y) => (x.micros === y.micros ? (x.t.id < y.t.id ? 1 : -1) : BigInt(x.micros) < BigInt(y.micros) ? 1 : -1));
  } else {
    rows = await base().where(and(...filters)).orderBy(...order).limit(q.limit + 1);
  }
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: page.map(toDto), nextCursor: rows.length > q.limit && last ? encodeCursor(last.ts, last.t.id) : null };
}

/** Full picture of one transaction for investigation: parties, failure, ledger entries, reversal links and audit trail. */
export async function adminGetTransaction(publicId: string) {
  const [row] = await base().where(eq(transactions.publicId, publicId)).limit(1);
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', 'Transaction not found');

  const entries = await db
    .select({ e: ledgerEntries, name: users.name, email: users.email, isSystem: wallets.isSystem })
    .from(ledgerEntries)
    .innerJoin(wallets, eq(wallets.id, ledgerEntries.walletId))
    .leftJoin(users, eq(users.id, wallets.userId))
    .where(eq(ledgerEntries.transactionId, row.t.id))
    .orderBy(ledgerEntries.id);
  const [reversal] = await db.select({ publicId: transactions.publicId }).from(transactions).where(eq(transactions.reversalOfTransactionId, row.t.id)).limit(1);
  const [original] = row.t.reversalOfTransactionId
    ? await db.select({ publicId: transactions.publicId }).from(transactions).where(eq(transactions.id, row.t.reversalOfTransactionId)).limit(1)
    : [];
  const trail = await db.select().from(auditLogs).where(eq(auditLogs.entityId, row.t.id)).orderBy(desc(auditLogs.createdAt)).limit(20);

  return {
    ...toDto(row),
    metadata: row.t.metadata,
    paymentRequestId: row.t.paymentRequestId,
    hasIdempotencyKey: row.t.idempotencyKeyId !== null,
    reversedBy: reversal?.publicId ?? null,
    reversalOf: original?.publicId ?? null,
    // A transfer can be reversed once, and only if it completed.
    canReverse: row.t.type === 'TRANSFER' && row.t.status === 'SUCCESS' && !reversal,
    ledgerEntries: entries.map((x) => ({
      id: x.e.id.toString(),
      type: x.e.type,
      amount: x.e.amount,
      balanceBefore: x.e.balanceBefore,
      balanceAfter: x.e.balanceAfter,
      wallet: { id: x.e.walletId, name: x.name ?? (x.isSystem ? 'CoinHub (platform wallet)' : null), email: x.email },
      createdAt: x.e.createdAt,
    })),
    auditTrail: trail.map((a) => ({ id: a.id.toString(), action: a.action, severity: a.severity, createdAt: a.createdAt, metadata: a.metadata })),
  };
}

// ------------------------------------------------------------------ audit log

/** Actions that deserve an admin's attention, shown on the suspicious-activity screen. */
export const WATCHED_ACTIONS = [
  'SUSPICIOUS_ACTIVITY',
  'PIN_LOCKED',
  'REFRESH_TOKEN_REUSE_DETECTED',
  'REVERSAL_BLOCKED_INSUFFICIENT_FUNDS',
  'RECONCILIATION_FAILED',
  'GATEWAY_AMOUNT_MISMATCH',
] as const;

export const auditQuery = z.object({
  userId: z.string().uuid().optional(),
  action: z.string().trim().max(80).optional(),
  severity: z.enum(['INFO', 'WARN', 'CRITICAL']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;

/** Audit ids are numeric (bigserial), so this cursor is (created_at text, id digits) rather than a UUID pair. */
function decodeAuditCursor(cursor: string): [string, string] {
  try {
    const [ts, id] = z.tuple([z.string(), z.string().regex(/^\d{1,19}$/)]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return [ts, id];
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
  }
}

const actor = alias(users, 'actor');
const target = alias(users, 'target');

export async function adminListAudit(q: AuditQuery, opts: { suspiciousOnly?: boolean } = {}) {
  const filters: (SQL | undefined)[] = [];
  if (q.userId) filters.push(or(eq(auditLogs.userId, q.userId), eq(auditLogs.targetUserId, q.userId)));
  if (q.action) filters.push(eq(auditLogs.action, q.action));
  if (q.severity) filters.push(eq(auditLogs.severity, q.severity));
  if (q.from) filters.push(gte(auditLogs.createdAt, q.from));
  if (q.to) filters.push(lte(auditLogs.createdAt, q.to));
  if (opts.suspiciousOnly) filters.push(or(inArray(auditLogs.action, [...WATCHED_ACTIONS]), eq(auditLogs.severity, 'CRITICAL')));
  if (q.cursor) {
    const [ts, id] = decodeAuditCursor(q.cursor);
    filters.push(sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${ts}::timestamptz, ${id}::bigint)`);
  }
  const rows = await db
    .select({ a: auditLogs, actorName: actor.name, actorEmail: actor.email, targetName: target.name, targetEmail: target.email, ts: sql<string>`${auditLogs.createdAt}::text` })
    .from(auditLogs)
    .leftJoin(actor, eq(actor.id, auditLogs.userId))
    .leftJoin(target, eq(target.id, auditLogs.targetUserId))
    .where(and(...filters))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.a.id.toString(),
      action: r.a.action,
      severity: r.a.severity,
      actor: r.a.userId ? { id: r.a.userId, name: r.actorName, email: r.actorEmail } : null,
      target: r.a.targetUserId ? { id: r.a.targetUserId, name: r.targetName, email: r.targetEmail } : null,
      entityType: r.a.entityType,
      entityId: r.a.entityId,
      ipAddress: r.a.ipAddress,
      userAgent: r.a.userAgent,
      requestId: r.a.requestId,
      metadata: r.a.metadata,
      createdAt: r.a.createdAt,
    })),
    nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.ts, last.a.id.toString()])).toString('base64url') : null,
  };
}
