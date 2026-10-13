import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { db, type DbTx } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import { outboxEvents, transactions, users, wallets } from '../../db/schema/index.js';
import { AppError, type ErrorCode } from '../../lib/errors.js';
import { newTransactionPublicId } from '../../lib/ids.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { audit } from '../audit/audit.service.js';
import { flagSuspiciousTransfer } from '../fraud/fraud.service.js';
import { verifyPin } from '../security/pin.service.js';
import { getBool, getNumber } from '../settings/settings.service.js';
import { applyTransfer, type LockedWallet } from './ledger.js';
import { getWalletForUser } from './wallet.service.js';

/** Business refusals worth keeping in the user's history as FAILED transactions. */
const RECORDED_FAILURES: ErrorCode[] = ['INSUFFICIENT_BALANCE', 'LIMIT_EXCEEDED', 'WALLET_FROZEN', 'RECEIVER_WALLET_FROZEN'];

export interface Recipient {
  userId: string;
  name: string;
  walletId: string;
}

/** Finds an active user with an active-or-frozen wallet by email or id. */
export async function findRecipient(by: { email?: string; userId?: string }): Promise<Recipient> {
  const cond = by.userId ? eq(users.id, by.userId) : eq(sql`lower(${users.email})`, (by.email ?? '').toLowerCase());
  const [row] = await db
    .select({ userId: users.id, name: users.name, walletId: wallets.id })
    .from(users)
    .innerJoin(wallets, eq(wallets.userId, users.id))
    .where(and(cond, eq(users.status, 'ACTIVE')))
    .limit(1);
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', 'Recipient not found');
  return row;
}

/** Start of "today" in India, so the daily limit resets at local midnight. */
const istDayStart = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

export async function assertWithinDailyLimit(tx: DbTx, senderUserId: string, senderWalletId: string, amount: bigint) {
  const [u] = await tx.select({ o: users.dailyLimitOverride }).from(users).where(eq(users.id, senderUserId));
  const limit = u?.o ?? (await getNumber('limits.daily_send'));
  // Runs while the sender wallet is row-locked, so concurrent sends cannot both squeeze under the limit.
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.senderWalletId, senderWalletId),
        inArray(transactions.type, ['TRANSFER', 'WITHDRAWAL']),
        // Completed sends, plus withdrawals still in flight (that money has already left the wallet).
        or(eq(transactions.status, 'SUCCESS'), and(eq(transactions.type, 'WITHDRAWAL'), eq(transactions.status, 'PROCESSING'))),
        sql`${transactions.createdAt} >= ${istDayStart}`,
      ),
    );
  if (BigInt(row?.total ?? 0) + amount > limit) {
    throw new AppError('LIMIT_EXCEEDED', 'This would exceed your daily sending limit');
  }
}

export interface SendInput {
  receiver: { email?: string; userId?: string };
  amount: bigint;
  note?: string | undefined;
  pin: string;
  /** Links the transfer to the payment request it settles. */
  paymentRequestId?: string;
  /** Run inside the money transaction before funds move (e.g. lock and re-check a payment request). */
  before?: (tx: DbTx) => Promise<void>;
  /** Run inside the same transaction after funds move (e.g. mark the request PAID), so both commit or neither does. */
  after?: (tx: DbTx, result: { transactionId: string; publicId: string }) => Promise<void>;
}

export async function sendMoney(req: Request, senderUserId: string, input: SendInput) {
  const senderWallet = await getWalletForUser(senderUserId);
  const receiver = await findRecipient(input.receiver);
  if (receiver.userId === senderUserId) throw new AppError('VALIDATION_ERROR', 'You cannot send money to yourself');

  await verifyPin(req, senderUserId, input.pin); // lockout-protected; failures are never recorded as transfers

  const [min, max, maxBalance, allowFrozen] = await Promise.all([
    getNumber('limits.min_transfer'),
    getNumber('limits.max_transfer'),
    getNumber('limits.max_wallet_balance'),
    getBool('wallet.allow_credit_to_frozen'),
  ]);
  if (input.amount < min) throw new AppError('LIMIT_EXCEEDED', `Minimum transfer is ${min / 100n} rupee(s)`);
  if (input.amount > max) throw new AppError('LIMIT_EXCEEDED', `Maximum per transfer is ${max / 100n} rupees`);

  try {
    const done = await withTransaction(async (tx) => {
      await input.before?.(tx);
      const result = await applyTransfer(tx, {
        type: 'TRANSFER',
        senderWalletId: senderWallet.id,
        receiverWalletId: receiver.walletId,
        amount: input.amount,
        initiatedBy: senderUserId,
        note: input.note ?? null,
        requestId: req.id,
        idempotencyKeyId: req.idempotencyKeyId ?? null,
        paymentRequestId: input.paymentRequestId ?? null,
        validate: async (s: LockedWallet, r: LockedWallet, conn) => {
          if (s.status !== 'ACTIVE') throw new AppError('WALLET_FROZEN', 'Your wallet is not active');
          if (r.status === 'CLOSED' || (r.status === 'FROZEN' && !allowFrozen)) {
            throw new AppError('RECEIVER_WALLET_FROZEN', 'The recipient cannot receive money right now');
          }
          if (r.balance + input.amount > maxBalance) {
            throw new AppError('LIMIT_EXCEEDED', 'The recipient cannot hold that much in their wallet');
          }
          await assertWithinDailyLimit(conn, senderUserId, s.id, input.amount);
        },
      });
      await input.after?.(tx, { transactionId: result.transaction.id, publicId: result.transaction.publicId });
      const base = { aggregateType: 'transaction', aggregateId: result.transaction.id };
      const payload = { transactionId: result.transaction.id, publicId: result.transaction.publicId, amount: input.amount.toString(), ...(input.paymentRequestId ? { viaRequest: '1' } : {}) };
      await tx.insert(outboxEvents).values([
        { ...base, eventType: 'MONEY_SENT', payload: { ...payload, userId: senderUserId, counterpartyId: receiver.userId } },
        { ...base, eventType: 'MONEY_RECEIVED', payload: { ...payload, userId: receiver.userId, counterpartyId: senderUserId } },
      ]);
      return { transaction: result.transaction, receiverName: receiver.name };
    });
    await invalidate(cacheKeys.summary(senderWallet.id), cacheKeys.summary(receiver.walletId));
    await flagSuspiciousTransfer(req, { userId: senderUserId, receiverUserId: receiver.userId, senderWalletId: senderWallet.id, receiverWalletId: receiver.walletId, amount: input.amount, transactionId: done.transaction.id, publicId: done.transaction.publicId });
    return done;
  } catch (err) {
    if (err instanceof AppError && RECORDED_FAILURES.includes(err.code)) {
      await recordFailedTransfer(req, senderWallet.id, receiver.walletId, senderUserId, input, err);
    }
    throw err;
  }
}

/** Written outside the rolled-back money transaction, so history shows the attempt without any balance change. */
async function recordFailedTransfer(req: Request, senderWalletId: string, receiverWalletId: string, userId: string, input: SendInput, err: AppError) {
  try {
    await db.insert(transactions).values({
      publicId: newTransactionPublicId(),
      type: 'TRANSFER',
      status: 'FAILED',
      amount: input.amount,
      senderWalletId,
      receiverWalletId,
      initiatedBy: userId,
      note: input.note ?? null,
      failureCode: err.code,
      failureReason: err.message,
      requestId: req.id,
      processedAt: new Date(),
      completedAt: new Date(),
    });
    await audit(req, { action: 'TRANSFER_FAILED', userId, severity: 'INFO', metadata: { code: err.code, amount: input.amount.toString() } });
  } catch {
    // Recording is best effort; the original error is what the caller must see.
  }
}
