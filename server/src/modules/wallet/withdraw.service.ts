import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { withTransaction } from '../../db/transaction.js';
import { bankAccounts, outboxEvents, transactions } from '../../db/schema/index.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { destinationLabel, getOwnedAccount } from '../bank-accounts/bank-accounts.service.js';
import { verifyPin } from '../security/pin.service.js';
import { getNumber } from '../settings/settings.service.js';
import { applyTransfer, getSystemWallet } from './ledger.js';
import { assertWithinDailyLimit } from './transfer.service.js';
import { getWalletForUser } from './wallet.service.js';

/**
 * Withdraw to a saved payout account. The money leaves the wallet NOW (held in the platform clearing wallet) and the
 * transaction stays PROCESSING; the payout job later marks it SUCCESS, or FAILED with an automatic refund.
 * The "request" event is written in the same commit, so a payout job exists if and only if the money is held.
 */
export async function withdraw(req: Request, userId: string, input: { bankAccountId: string; amount: bigint; pin: string }) {
  const wallet = await getWalletForUser(userId);
  const account = await getOwnedAccount(userId, input.bankAccountId);
  await verifyPin(req, userId, input.pin);

  const [min, max] = await Promise.all([getNumber('limits.min_transfer'), getNumber('limits.max_transfer')]);
  if (input.amount < min) throw new AppError('LIMIT_EXCEEDED', `Minimum withdrawal is ${min / 100n} rupee(s)`);
  if (input.amount > max) throw new AppError('LIMIT_EXCEEDED', `Maximum per withdrawal is ${max / 100n} rupees`);

  const destination = destinationLabel(account);
  const txn = await withTransaction(async (tx) => {
    const system = await getSystemWallet(tx);
    const result = await applyTransfer(tx, {
      type: 'WITHDRAWAL',
      senderWalletId: wallet.id,
      receiverWalletId: system.id,
      amount: input.amount,
      initiatedBy: userId,
      requestId: req.id,
      idempotencyKeyId: req.idempotencyKeyId ?? null,
      metadata: { bankAccountId: account.id, destination },
      finalStatus: 'PROCESSING',
      validate: async (sender, _receiver, conn) => {
        if (sender.status !== 'ACTIVE') throw new AppError('WALLET_FROZEN', 'Your wallet is not active');
        await assertWithinDailyLimit(conn, userId, sender.id, input.amount);
      },
    });
    await tx.insert(outboxEvents).values({
      aggregateType: 'transaction',
      aggregateId: result.transaction.id,
      eventType: 'WITHDRAWAL_REQUESTED',
      payload: { transactionId: result.transaction.id, publicId: result.transaction.publicId, userId, amount: input.amount.toString(), destination },
    });
    await audit(req, { action: 'WITHDRAWAL_REQUESTED', userId, entityType: 'transaction', entityId: result.transaction.id, metadata: { amount: input.amount.toString() } }, tx);
    return result.transaction;
  });
  await invalidate(cacheKeys.summary(wallet.id));
  return { transaction: txn, destination };
}

export type PayoutOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED';

/**
 * Settles a held withdrawal. Idempotent: the transaction row is locked and only a PROCESSING one is touched, so a retried
 * or duplicated job does nothing the second time. Success completes it. Failure marks it FAILED and posts a linked
 * REVERSAL that returns the held funds (the unique reversal link means the refund can only happen once).
 *
 * The bank is simulated: a payout account whose holder name contains "fail" is rejected, which makes the refund path
 * easy to demonstrate. A real integration replaces `bankAccepts`.
 */
export const bankAccepts = (holderName: string): boolean => !/fail/i.test(holderName);

export async function processPayout(transactionId: string): Promise<PayoutOutcome> {
  let walletId: string | undefined;
  const outcome = await withTransaction(async (tx): Promise<PayoutOutcome> => {
    const [t] = await tx.select().from(transactions).where(eq(transactions.id, transactionId)).for('update');
    if (!t || t.type !== 'WITHDRAWAL' || t.status !== 'PROCESSING') return 'SKIPPED';
    const meta = (t.metadata ?? {}) as { bankAccountId?: string; destination?: string };
    const [account] = meta.bankAccountId ? await tx.select().from(bankAccounts).where(eq(bankAccounts.id, meta.bankAccountId)) : [];
    const payload = { transactionId: t.id, publicId: t.publicId, userId: t.initiatedBy ?? '', amount: t.amount.toString(), destination: meta.destination ?? 'your bank' };
    walletId = t.senderWalletId;

    if (account && bankAccepts(account.holderName)) {
      await tx.update(transactions).set({ status: 'SUCCESS', completedAt: new Date() }).where(eq(transactions.id, t.id));
      await tx.insert(outboxEvents).values({ aggregateType: 'transaction', aggregateId: t.id, eventType: 'WITHDRAWAL_COMPLETED', payload });
      return 'SUCCESS';
    }

    const reason = account ? 'Rejected by the bank' : 'Payout account not found';
    await tx.update(transactions).set({ status: 'FAILED', failureCode: 'PAYOUT_REJECTED', failureReason: reason, completedAt: new Date() }).where(eq(transactions.id, t.id));
    await applyTransfer(tx, {
      type: 'REVERSAL',
      senderWalletId: t.receiverWalletId, // the platform clearing wallet that held the funds
      receiverWalletId: t.senderWalletId,
      amount: t.amount,
      reversalOfTransactionId: t.id,
      note: `Refund of failed withdrawal ${t.publicId}`,
    });
    await tx.insert(outboxEvents).values({ aggregateType: 'transaction', aggregateId: t.id, eventType: 'WITHDRAWAL_FAILED', payload: { ...payload, reason } });
    return 'FAILED';
  });
  if (walletId) await invalidate(cacheKeys.summary(walletId));
  return outcome;
}

