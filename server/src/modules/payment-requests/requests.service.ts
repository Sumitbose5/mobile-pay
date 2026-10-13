import { and, count, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Request } from 'express';
import { z } from 'zod';
import { db, type DbTx } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import { outboxEvents, paymentRequests, transactions, users } from '../../db/schema/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { getNumber } from '../settings/settings.service.js';
import { findRecipient, sendMoney } from '../wallet/transfer.service.js';

const MAX_OPEN = 20;
const requester = alias(users, 'requester');
const payer = alias(users, 'payer');

export const listQuery = z.object({
  box: z.enum(['received', 'sent']).default('received'),
  status: z.enum(['PENDING', 'PAID', 'REJECTED', 'CANCELLED', 'EXPIRED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

const selection = {
  r: paymentRequests,
  requesterName: requester.name,
  requesterEmail: requester.email,
  payerName: payer.name,
  payerEmail: payer.email,
  txnPublicId: transactions.publicId,
  ts: sql<string>`${paymentRequests.createdAt}::text`,
};
type Row = { r: typeof paymentRequests.$inferSelect; requesterName: string; requesterEmail: string; payerName: string; payerEmail: string; txnPublicId: string | null; ts: string };

const toDto = (x: Row) => ({
  id: x.r.id,
  amount: x.r.amount,
  note: x.r.note,
  status: x.r.status,
  createdAt: x.r.createdAt,
  expiresAt: x.r.expiresAt,
  respondedAt: x.r.respondedAt,
  requester: { id: x.r.requesterId, name: x.requesterName, email: x.requesterEmail },
  payer: { id: x.r.payerId, name: x.payerName, email: x.payerEmail },
  transactionId: x.txnPublicId,
});

const base = () =>
  db
    .select(selection)
    .from(paymentRequests)
    .innerJoin(requester, eq(requester.id, paymentRequests.requesterId))
    .innerJoin(payer, eq(payer.id, paymentRequests.payerId))
    .leftJoin(transactions, eq(transactions.id, paymentRequests.transactionId));

const outbox = (tx: DbTx, id: string, eventType: string, payload: Record<string, string>) =>
  tx.insert(outboxEvents).values({ aggregateType: 'payment_request', aggregateId: id, eventType, payload });

export async function createRequest(req: Request, requesterId: string, input: { payerEmail: string; amount: bigint; note?: string | undefined }) {
  const target = await findRecipient({ email: input.payerEmail });
  if (target.userId === requesterId) throw new AppError('VALIDATION_ERROR', 'You cannot request money from yourself');
  const [min, max, expiryDays] = await Promise.all([getNumber('limits.min_transfer'), getNumber('limits.max_transfer'), getNumber('payment_request.expiry_days')]);
  if (input.amount < min || input.amount > max) throw new AppError('LIMIT_EXCEEDED', `Request amount must be between ${min / 100n} and ${max / 100n} rupees`);

  return withTransaction(async (tx) => {
    // Serialise a requester's own creations so the open-request cap cannot be bypassed in parallel.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payreq:' + requesterId}))`);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(paymentRequests).where(and(eq(paymentRequests.requesterId, requesterId), eq(paymentRequests.status, 'PENDING')));
    if (n >= MAX_OPEN) throw new AppError('LIMIT_EXCEEDED', `You can have up to ${MAX_OPEN} open requests`);

    const [created] = await tx
      .insert(paymentRequests)
      .values({ requesterId, payerId: target.userId, amount: input.amount, note: input.note?.trim() || null, expiresAt: new Date(Date.now() + Number(expiryDays) * 86_400_000) })
      .returning();
    await outbox(tx, created!.id, 'REQUEST_CREATED', { requestId: created!.id, requesterId, payerId: target.userId, amount: input.amount.toString(), note: created!.note ?? '' });
    await audit(req, { action: 'PAYMENT_REQUEST_CREATED', userId: requesterId, targetUserId: target.userId, entityType: 'payment_request', entityId: created!.id, metadata: { amount: input.amount.toString() } }, tx);
    return created!;
  });
}

export async function getRequest(userId: string, id: string) {
  const [x] = await base().where(eq(paymentRequests.id, id));
  // A request you are not part of looks like a missing one.
  if (!x || (x.r.requesterId !== userId && x.r.payerId !== userId)) throw new AppError('RESOURCE_NOT_FOUND', 'Payment request not found');
  return toDto(x);
}

export async function listRequests(userId: string, q: z.infer<typeof listQuery>) {
  const filters: (SQL | undefined)[] = [q.box === 'received' ? eq(paymentRequests.payerId, userId) : eq(paymentRequests.requesterId, userId)];
  if (q.status) filters.push(eq(paymentRequests.status, q.status));
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    filters.push(sql`(${paymentRequests.createdAt}, ${paymentRequests.id}) < (${ts}::timestamptz, ${id}::uuid)`);
  }
  const rows = await base()
    .where(and(...filters))
    .orderBy(desc(paymentRequests.createdAt), desc(paymentRequests.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: page.map(toDto), nextCursor: rows.length > q.limit && last ? encodeCursor(last.ts, last.r.id) : null };
}

/** Locks the request row and returns it only if `userId` may act on it and it is still open. */
async function lockOpenRequest(tx: DbTx, id: string, userId: string, role: 'payer' | 'requester') {
  const [r] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, id)).for('update');
  if (!r || (role === 'payer' ? r.payerId : r.requesterId) !== userId) throw new AppError('RESOURCE_NOT_FOUND', 'Payment request not found');
  if (r.status !== 'PENDING') throw new AppError('REQUEST_NOT_PENDING', `This request was already ${r.status.toLowerCase()}`);
  if (r.expiresAt <= new Date()) throw new AppError('REQUEST_NOT_PENDING', 'This request has expired');
  return r;
}

/**
 * Pays a request through the normal send-money path (PIN, limits, wallet checks, idempotency, ledger). The request row
 * is locked inside the money transaction and flipped to PAID in the SAME commit, so paying and rejecting (or paying
 * twice) at the same moment can only ever produce one outcome and one transfer.
 */
export async function payRequest(req: Request, payerId: string, id: string, pin: string) {
  // Cheap pre-check so an already-settled request does not spend one of the user's PIN attempts.
  const [pre] = await db.select().from(paymentRequests).where(eq(paymentRequests.id, id));
  if (!pre || pre.payerId !== payerId) throw new AppError('RESOURCE_NOT_FOUND', 'Payment request not found');
  if (pre.status !== 'PENDING' || pre.expiresAt <= new Date()) throw new AppError('REQUEST_NOT_PENDING', pre.status === 'PENDING' ? 'This request has expired' : `This request was already ${pre.status.toLowerCase()}`);

  const { transaction } = await sendMoney(req, payerId, {
    receiver: { userId: pre.requesterId },
    amount: pre.amount,
    note: pre.note ?? 'Payment request',
    pin,
    paymentRequestId: pre.id,
    before: async (tx) => {
      await lockOpenRequest(tx, id, payerId, 'payer');
    },
    after: async (tx, result) => {
      await tx.update(paymentRequests).set({ status: 'PAID', transactionId: result.transactionId, respondedAt: new Date(), updatedAt: new Date() }).where(eq(paymentRequests.id, id));
      await outbox(tx, id, 'REQUEST_PAID', { requestId: id, requesterId: pre.requesterId, payerId, amount: pre.amount.toString(), publicId: result.publicId });
    },
  });
  return { request: await getRequest(payerId, id), transaction };
}

async function settle(req: Request, userId: string, id: string, role: 'payer' | 'requester', status: 'REJECTED' | 'CANCELLED', eventType: string, action: string) {
  await withTransaction(async (tx) => {
    const r = await lockOpenRequest(tx, id, userId, role);
    await tx.update(paymentRequests).set({ status, respondedAt: new Date(), updatedAt: new Date() }).where(eq(paymentRequests.id, id));
    await outbox(tx, id, eventType, { requestId: id, requesterId: r.requesterId, payerId: r.payerId, amount: r.amount.toString() });
    await audit(req, { action, userId, targetUserId: role === 'payer' ? r.requesterId : r.payerId, entityType: 'payment_request', entityId: id }, tx);
  });
  return getRequest(userId, id);
}

export const rejectRequest = (req: Request, payerId: string, id: string) => settle(req, payerId, id, 'payer', 'REJECTED', 'REQUEST_REJECTED', 'PAYMENT_REQUEST_REJECTED');
export const cancelRequest = (req: Request, requesterId: string, id: string) => settle(req, requesterId, id, 'requester', 'CANCELLED', 'REQUEST_CANCELLED', 'PAYMENT_REQUEST_CANCELLED');

/** Scheduled job: marks overdue PENDING requests EXPIRED and tells the requester, in one transaction. */
export async function expireRequests(): Promise<number> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .update(paymentRequests)
      .set({ status: 'EXPIRED', respondedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(paymentRequests.status, ['PENDING']), lt(paymentRequests.expiresAt, new Date())))
      .returning();
    for (const r of rows) await outbox(tx, r.id, 'REQUEST_EXPIRED', { requestId: r.id, requesterId: r.requesterId, payerId: r.payerId, amount: r.amount.toString() });
    return rows.length;
  });
}
