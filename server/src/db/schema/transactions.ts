import {
  type AnyPgColumn,
  char,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, money, sql, ts } from './_helpers.js';
import { transactionStatus, transactionType } from './enums.js';
import { idempotencyKeys } from './idempotencyKeys.js';
import { paymentOrders } from './paymentOrders.js';
import { paymentRequests } from './paymentRequests.js';
import { users } from './users.js';
import { wallets } from './wallets.js';

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: varchar('public_id', { length: 32 }).notNull(),
    type: transactionType('type').notNull(),
    status: transactionStatus('status').notNull().default('PENDING'),
    amount: money('amount').notNull(),
    fee: money('fee').notNull().default(sql`0`),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    // For ADD_MONEY the sender is the system clearing wallet; for WITHDRAWAL the receiver is.
    senderWalletId: uuid('sender_wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    receiverWalletId: uuid('receiver_wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'restrict' }),
    note: varchar('note', { length: 255 }),
    referenceId: varchar('reference_id', { length: 100 }),
    paymentRequestId: uuid('payment_request_id').references((): AnyPgColumn => paymentRequests.id, {
      onDelete: 'restrict',
    }),
    paymentOrderId: uuid('payment_order_id').references((): AnyPgColumn => paymentOrders.id, {
      onDelete: 'restrict',
    }),
    reversalOfTransactionId: uuid('reversal_of_transaction_id').references(
      (): AnyPgColumn => transactions.id,
      { onDelete: 'restrict' },
    ),
    failureCode: varchar('failure_code', { length: 50 }),
    failureReason: text('failure_reason'),
    // The key is ephemeral (purged after 24 h); the transaction is permanent. Deleting a key must not be blocked
    // by, or erase, the money record, so the link is simply cleared.
    idempotencyKeyId: uuid('idempotency_key_id').references(() => idempotencyKeys.id, {
      onDelete: 'set null',
    }),
    requestId: varchar('request_id', { length: 64 }),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    processedAt: ts('processed_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    check('transactions_amount_positive', sql`${t.amount} > 0`),
    check('transactions_fee_non_negative', sql`${t.fee} >= 0`),
    check('transactions_not_self', sql`${t.senderWalletId} <> ${t.receiverWalletId}`),
    check(
      'transactions_terminal_has_completed_at',
      sql`${t.status} NOT IN ('SUCCESS','FAILED','CANCELLED') OR ${t.completedAt} IS NOT NULL`,
    ),
    uniqueIndex('transactions_public_id_uq').on(t.publicId),
    uniqueIndex('transactions_reversal_of_uq').on(t.reversalOfTransactionId),
    // (wallet, created_at DESC, id DESC) with NULLS FIRST matches the history ORDER BY exactly (a plain DESC sort is
    // NULLS FIRST), so PostgreSQL reads a page straight off the index instead of sorting the wallet's history.
    index('transactions_sender_created_idx').on(t.senderWalletId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('transactions_receiver_created_idx').on(t.receiverWalletId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    // Admin monitoring reads newest-first across all wallets, optionally by status or type. Each index matches the
    // ORDER BY (created_at DESC, id DESC, NULLS FIRST) exactly so a page is read straight off the index.
    index('transactions_created_idx').on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('transactions_status_created_idx').on(t.status, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('transactions_type_created_idx').on(t.type, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('transactions_reference_idx').on(t.referenceId),
    index('transactions_payment_request_idx').on(t.paymentRequestId),
    index('transactions_payment_order_idx').on(t.paymentOrderId),
    // Workers scanning for in-flight transactions only touch this small index.
    index('transactions_inflight_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('PENDING','PROCESSING')`),
    // Fuzzy search on notes (requires pg_trgm, created in the extensions migration).
    index('transactions_note_trgm_idx').using('gin', t.note.op('gin_trgm_ops')),
  ],
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
