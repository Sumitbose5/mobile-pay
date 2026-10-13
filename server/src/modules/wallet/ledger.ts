import { eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '../../db/client.js';
import { ledgerEntries, transactions, wallets } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { newTransactionPublicId } from '../../lib/ids.js';

export interface TransferInput {
  type: 'ADD_MONEY' | 'TRANSFER' | 'WITHDRAWAL' | 'REVERSAL';
  senderWalletId: string;
  receiverWalletId: string;
  amount: bigint;
  initiatedBy?: string | null;
  note?: string | null;
  referenceId?: string | null;
  paymentOrderId?: string | null;
  paymentRequestId?: string | null;
  reversalOfTransactionId?: string | null;
  idempotencyKeyId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * SUCCESS (default) completes the transaction. PROCESSING leaves it in flight after the money has moved, for
   * flows that finish asynchronously (withdrawals: funds are held now, the bank result arrives later).
   */
  finalStatus?: 'SUCCESS' | 'PROCESSING';
  /** Called with the locked wallet rows before money moves, for business checks (status, limits). */
  validate?: (sender: LockedWallet, receiver: LockedWallet, tx: DbTx) => void | Promise<void>;
}

export type LockedWallet = typeof wallets.$inferSelect;

/**
 * The single place where money moves. Must run inside a caller-owned DB transaction.
 *
 *  1. Lock both wallets with SELECT ... FOR UPDATE in ascending id order (no deadlocks, whoever sends).
 *  2. Run business validation against the LOCKED rows (so a concurrent freeze or spend is seen).
 *  3. Check funds (only the system clearing wallet may go negative).
 *  4. Insert the transaction, move both balances, write the two ledger entries, mark SUCCESS.
 *
 * The database independently enforces balance >= 0, balanced ledger and the state machine.
 */
export async function applyTransfer(tx: DbTx, input: TransferInput) {
  if (input.amount <= 0n) throw new AppError('VALIDATION_ERROR', 'Amount must be greater than zero');
  if (input.senderWalletId === input.receiverWalletId) {
    throw new AppError('VALIDATION_ERROR', 'Sender and receiver must be different wallets');
  }

  const locked = await tx
    .select()
    .from(wallets)
    .where(inArray(wallets.id, [input.senderWalletId, input.receiverWalletId]))
    .orderBy(wallets.id)
    .for('update');
  const sender = locked.find((w) => w.id === input.senderWalletId);
  const receiver = locked.find((w) => w.id === input.receiverWalletId);
  if (!sender || !receiver) throw new AppError('RESOURCE_NOT_FOUND', 'Wallet not found');

  await input.validate?.(sender, receiver, tx);

  if (!sender.isSystem && sender.balance < input.amount) {
    throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient wallet balance');
  }

  const [txn] = await tx
    .insert(transactions)
    .values({
      publicId: newTransactionPublicId(),
      type: input.type,
      status: 'PROCESSING',
      amount: input.amount,
      senderWalletId: sender.id,
      receiverWalletId: receiver.id,
      initiatedBy: input.initiatedBy ?? null,
      note: input.note ?? null,
      referenceId: input.referenceId ?? null,
      paymentOrderId: input.paymentOrderId ?? null,
      paymentRequestId: input.paymentRequestId ?? null,
      reversalOfTransactionId: input.reversalOfTransactionId ?? null,
      idempotencyKeyId: input.idempotencyKeyId ?? null,
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? null,
      processedAt: new Date(),
    })
    .returning();
  if (!txn) throw new AppError('TRANSACTION_FAILED', 'Could not record transaction');

  const senderAfter = sender.balance - input.amount;
  const receiverAfter = receiver.balance + input.amount;

  await tx
    .update(wallets)
    .set({ balance: senderAfter, version: sql`${wallets.version} + 1`, updatedAt: new Date() })
    .where(eq(wallets.id, sender.id));
  await tx
    .update(wallets)
    .set({ balance: receiverAfter, version: sql`${wallets.version} + 1`, updatedAt: new Date() })
    .where(eq(wallets.id, receiver.id));

  await tx.insert(ledgerEntries).values([
    { transactionId: txn.id, walletId: sender.id, type: 'DEBIT', amount: input.amount, balanceBefore: sender.balance, balanceAfter: senderAfter },
    { transactionId: txn.id, walletId: receiver.id, type: 'CREDIT', amount: input.amount, balanceBefore: receiver.balance, balanceAfter: receiverAfter },
  ]);

  if (input.finalStatus === 'PROCESSING') {
    return { transaction: txn, sender: { ...sender, balance: senderAfter }, receiver: { ...receiver, balance: receiverAfter } };
  }
  const [done] = await tx
    .update(transactions)
    .set({ status: 'SUCCESS', completedAt: new Date() })
    .where(eq(transactions.id, txn.id))
    .returning();
  return { transaction: done ?? txn, sender: { ...sender, balance: senderAfter }, receiver: { ...receiver, balance: receiverAfter } };
}

/** The platform clearing wallet: counterparty for add-money and withdrawals. */
export async function getSystemWallet(tx: DbTx): Promise<LockedWallet> {
  const [w] = await tx.select().from(wallets).where(eq(wallets.isSystem, true)).limit(1);
  if (!w) throw new AppError('INTERNAL_ERROR', 'System wallet missing. Run `npm run db:seed`.');
  return w;
}
