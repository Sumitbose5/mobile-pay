import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { pgErrorCode, withTransaction } from '../../db/transaction.js';
import { outboxEvents, transactions } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { audit } from '../audit/audit.service.js';
import { applyTransfer } from './ledger.js';

/**
 * Reverses a completed transfer by posting a NEW linked transaction that moves the money back.
 * History is never edited: the original stays SUCCESS and the reversal appears beside it.
 *
 * Safe against races: the original row is locked, and a unique index on `reversal_of_transaction_id`
 * is the backstop, so two admins clicking at once can reverse a transfer at most once.
 * Works on frozen wallets (this is an operations action, so wallet status and limits are not applied),
 * but cannot create money: if the receiver already spent it, the reversal fails and is flagged.
 */
export async function reverseTransaction(req: Request, adminId: string, publicId: string, reason: string) {
  try {
    const done = await withTransaction(async (tx) => {
      const [original] = await tx.select().from(transactions).where(eq(transactions.publicId, publicId)).for('update');
      if (!original) throw new AppError('RESOURCE_NOT_FOUND', 'Transaction not found');
      if (original.type !== 'TRANSFER') throw new AppError('VALIDATION_ERROR', 'Only transfers between users can be reversed');
      if (original.status !== 'SUCCESS') throw new AppError('VALIDATION_ERROR', 'Only successful transactions can be reversed');

      const [already] = await tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.reversalOfTransactionId, original.id)).limit(1);
      if (already) throw new AppError('DUPLICATE_TRANSACTION', 'This transaction has already been reversed');

      const result = await applyTransfer(tx, {
        type: 'REVERSAL',
        senderWalletId: original.receiverWalletId,
        receiverWalletId: original.senderWalletId,
        amount: original.amount,
        initiatedBy: adminId,
        note: `Reversal of ${original.publicId}: ${reason}`.slice(0, 255),
        reversalOfTransactionId: original.id,
        requestId: req.id,
      });
      const base = { aggregateType: 'transaction', aggregateId: result.transaction.id };
      const payload = { transactionId: result.transaction.id, publicId: result.transaction.publicId, originalPublicId: original.publicId, amount: original.amount.toString(), reason };
      await tx.insert(outboxEvents).values([
        { ...base, eventType: 'REVERSAL_DEBITED', payload: { ...payload, walletId: original.receiverWalletId } },
        { ...base, eventType: 'REVERSAL_CREDITED', payload: { ...payload, walletId: original.senderWalletId } },
      ]);
      await audit(req, { action: 'TRANSACTION_REVERSED', userId: adminId, severity: 'WARN', entityType: 'transaction', entityId: original.id, metadata: { reversal: result.transaction.publicId, original: original.publicId, amount: original.amount.toString(), reason } }, tx);
      return { reversal: result.transaction, original };
    });
    await invalidate(cacheKeys.summary(done.original.senderWalletId), cacheKeys.summary(done.original.receiverWalletId));
    return done;
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new AppError('DUPLICATE_TRANSACTION', 'This transaction has already been reversed');
    if (err instanceof AppError && err.code === 'INSUFFICIENT_BALANCE') {
      // The receiver has already spent the money: a human has to decide what to do next.
      await audit(req, { action: 'REVERSAL_BLOCKED_INSUFFICIENT_FUNDS', userId: adminId, severity: 'CRITICAL', metadata: { original: publicId, reason } });
      throw new AppError('INSUFFICIENT_BALANCE', "The recipient no longer has enough balance to reverse this transfer. Flagged for manual handling.");
    }
    throw err;
  }
}
