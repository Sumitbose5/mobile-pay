import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { ledgerEntries, transactions, users, wallets } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { cached, cacheKeys } from '../../lib/cache.js';
import { getWalletForUser } from '../wallet/wallet.service.js';

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  direction: z.enum(['SENT', 'RECEIVED', 'ADDED', 'WITHDRAWN']).optional(),
  type: z.enum(['ADD_MONEY', 'TRANSFER', 'WITHDRAWAL', 'REVERSAL']).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minAmount: z.string().regex(/^\d{1,15}$/).optional(),
  maxAmount: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

const sw = alias(wallets, 'sw');
const rw = alias(wallets, 'rw');
const su = alias(users, 'su');
const ru = alias(users, 'ru');

/**
 * What a user may see: everything they sent or initiated, but as a receiver only transactions that actually
 * completed. Someone's failed or cancelled attempt to pay you is theirs alone.
 */
const visibleTo = (walletId: string) =>
  or(eq(transactions.senderWalletId, walletId), and(eq(transactions.receiverWalletId, walletId), eq(transactions.status, 'SUCCESS')))!;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Keyset cursor over (created_at, id). The timestamp travels as text to keep microsecond precision. */
const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const [ts, id] = z.tuple([z.string(), z.string().uuid()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return [ts, id];
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
  }
}

type Row = {
  t: typeof transactions.$inferSelect;
  senderName: string | null;
  senderEmail: string | null;
  receiverName: string | null;
  receiverEmail: string | null;
  cursorTs: string;
  micros: string;
  senderIsSystem: boolean;
  receiverIsSystem: boolean;
};

function direction(t: typeof transactions.$inferSelect, myWalletId: string): 'SENT' | 'RECEIVED' | 'ADDED' | 'WITHDRAWN' {
  if (t.type === 'ADD_MONEY') return 'ADDED';
  if (t.type === 'WITHDRAWAL') return 'WITHDRAWN';
  return t.senderWalletId === myWalletId ? 'SENT' : 'RECEIVED';
}

function toDto(r: Row, myWalletId: string) {
  const dir = direction(r.t, myWalletId);
  const sent = r.t.senderWalletId === myWalletId;
  // Platform-side counterparties (refunds come from the clearing wallet) are shown as CoinHub.
  const counterparty =
    dir === 'ADDED' || dir === 'WITHDRAWN'
      ? null
      : sent
        ? { name: r.receiverName ?? (r.receiverIsSystem ? 'CoinHub' : null), email: r.receiverEmail }
        : { name: r.senderName ?? (r.senderIsSystem ? 'CoinHub' : null), email: r.senderEmail };
  return {
    id: r.t.publicId,
    type: r.t.type,
    direction: dir,
    status: r.t.status,
    amount: r.t.amount,
    // Signed from the viewer's perspective; failed/cancelled attempts moved no money.
    // A withdrawal still being paid out has already left the wallet, so it counts; failed ones were refunded.
    signedAmount: r.t.status === 'SUCCESS' || (r.t.type === 'WITHDRAWAL' && r.t.status === 'PROCESSING') ? (sent ? -r.t.amount : r.t.amount) : 0n,
    counterparty,
    note: r.t.note,
    failureReason: r.t.status === 'FAILED' ? r.t.failureReason : null,
    createdAt: r.t.createdAt,
    completedAt: r.t.completedAt,
  };
}

const selection = {
  t: transactions,
  senderName: su.name,
  senderEmail: su.email,
  receiverName: ru.name,
  receiverEmail: ru.email,
  senderIsSystem: sw.isSystem,
  receiverIsSystem: rw.isSystem,
  cursorTs: sql<string>`${transactions.createdAt}::text`,
  // microsecond-exact sort key used to merge the two sides
  micros: sql<string>`(extract(epoch from ${transactions.createdAt}) * 1000000)::bigint::text`,
};

const baseQuery = () =>
  db
    .select(selection)
    .from(transactions)
    .innerJoin(sw, eq(sw.id, transactions.senderWalletId))
    .innerJoin(rw, eq(rw.id, transactions.receiverWalletId))
    .leftJoin(su, eq(su.id, sw.userId))
    .leftJoin(ru, eq(ru.id, rw.userId));

type Side = 'sender' | 'receiver';

/**
 * History is read as two index-friendly queries (my sent side and my received side), each newest-first
 * with its own LIMIT, then merged. A single `sender = me OR receiver = me` query forces PostgreSQL to read
 * the wallet's entire history and sort it; this way each side stops after one page worth of index entries.
 * Any row in the top N of the union is necessarily in the top N of its own side, so the merge is exact.
 */
export async function listTransactions(userId: string, q: ListQuery) {
  const wallet = await getWalletForUser(userId);

  const common: (SQL | undefined)[] = [];
  let sides: Side[] = ['sender', 'receiver'];
  const transferTypes = inArray(transactions.type, ['TRANSFER', 'REVERSAL']);
  // Same meaning as the `direction` shown on each row.
  if (q.direction === 'SENT') { sides = ['sender']; common.push(transferTypes); }
  if (q.direction === 'RECEIVED') { sides = ['receiver']; common.push(transferTypes); }
  if (q.direction === 'ADDED') { sides = ['receiver']; common.push(eq(transactions.type, 'ADD_MONEY')); }
  if (q.direction === 'WITHDRAWN') { sides = ['sender']; common.push(eq(transactions.type, 'WITHDRAWAL')); }
  if (q.type) common.push(eq(transactions.type, q.type));
  if (q.status) common.push(eq(transactions.status, q.status));
  if (q.from) common.push(gte(transactions.createdAt, q.from));
  if (q.to) common.push(lte(transactions.createdAt, q.to));
  if (q.minAmount) common.push(gte(transactions.amount, BigInt(q.minAmount)));
  if (q.maxAmount) common.push(lte(transactions.amount, BigInt(q.maxAmount)));
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    common.push(or(ilike(transactions.publicId, like), ilike(transactions.note, like), ilike(su.name, like), ilike(su.email, like), ilike(ru.name, like), ilike(ru.email, like)));
  }
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    common.push(sql`(${transactions.createdAt}, ${transactions.id}) < (${ts}::timestamptz, ${id}::uuid)`);
  }

  // As a receiver you only ever see completed transactions; a failed attempt to pay you is the sender's alone.
  const sideFilter = (side: Side) =>
    side === 'sender' ? eq(transactions.senderWalletId, wallet.id) : and(eq(transactions.receiverWalletId, wallet.id), eq(transactions.status, 'SUCCESS'));

  const results = await Promise.all(
    sides.map((side) =>
      baseQuery()
        .where(and(sideFilter(side), ...common))
        .orderBy(desc(transactions.createdAt), desc(transactions.id))
        .limit(q.limit + 1),
    ),
  );

  const merged = results
    .flat()
    .sort((x, y) => (x.micros === y.micros ? (x.t.id < y.t.id ? 1 : -1) : BigInt(x.micros) < BigInt(y.micros) ? 1 : -1));
  const page = merged.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDto(r, wallet.id)),
    nextCursor: merged.length > q.limit && last ? encodeCursor(last.cursorTs, last.t.id) : null,
  };
}

export async function getTransaction(userId: string, publicId: string) {
  const wallet = await getWalletForUser(userId);
  const [row] = await baseQuery()
    .where(and(eq(transactions.publicId, publicId), visibleTo(wallet.id)))
    .limit(1);
  // Someone else's transaction is indistinguishable from a missing one.
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', 'Transaction not found');

  const [entry] = await db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.transactionId, row.t.id), eq(ledgerEntries.walletId, wallet.id)))
    .limit(1);
  const [reversal] = await db.select({ publicId: transactions.publicId }).from(transactions).where(eq(transactions.reversalOfTransactionId, row.t.id)).limit(1);
  const [original] = row.t.reversalOfTransactionId
    ? await db.select({ publicId: transactions.publicId }).from(transactions).where(eq(transactions.id, row.t.reversalOfTransactionId)).limit(1)
    : [];

  return {
    ...toDto(row, wallet.id),
    referenceId: row.t.referenceId,
    failureCode: row.t.status === 'FAILED' ? row.t.failureCode : null,
    sender: row.t.type === 'ADD_MONEY' ? { name: 'Payment gateway', email: null } : { name: row.senderName, email: row.senderEmail },
    receiver: row.t.type === 'WITHDRAWAL' ? { name: 'Bank account', email: null } : { name: row.receiverName, email: row.receiverEmail },
    balanceBefore: entry?.balanceBefore ?? null,
    balanceAfter: entry?.balanceAfter ?? null,
    reversedBy: reversal?.publicId ?? null,
    reversalOf: original?.publicId ?? null,
  };
}

export async function recentTransactions(userId: string, limit = 5) {
  return (await listTransactions(userId, listQuery.parse({ limit }))).items;
}


/**
 * This month's money in and out, for the dashboard. A display aggregate only: cached 60 s and invalidated when the
 * wallet's money moves. "Month" starts at midnight on the 1st in India time.
 */
export async function monthlySummary(userId: string) {
  const wallet = await getWalletForUser(userId);
  return cached(cacheKeys.summary(wallet.id), 60, async () => {
    const w = wallet.id;
    const [row] = await db
      .select({
        month: sql<string>`to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`,
        sent: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.senderWalletId} = ${w} and ${transactions.type} in ('TRANSFER','REVERSAL')), 0)::text`,
        received: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.receiverWalletId} = ${w} and ${transactions.type} in ('TRANSFER','REVERSAL')), 0)::text`,
        added: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'ADD_MONEY'), 0)::text`,
        withdrawn: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'WITHDRAWAL'), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'SUCCESS'),
          or(eq(transactions.senderWalletId, w), eq(transactions.receiverWalletId, w)),
          sql`${transactions.createdAt} >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
        ),
      );
    return row!;
  });
}
