import { type AnyPgColumn, check, index, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, money, sql, ts, updatedAt } from './_helpers.js';
import { paymentRequestStatus } from './enums.js';
import { transactions } from './transactions.js';
import { users } from './users.js';

export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    payerId: uuid('payer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    note: varchar('note', { length: 255 }),
    status: paymentRequestStatus('status').notNull().default('PENDING'),
    transactionId: uuid('transaction_id').references((): AnyPgColumn => transactions.id, {
      onDelete: 'restrict',
    }),
    expiresAt: ts('expires_at').notNull(),
    respondedAt: ts('responded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('payment_requests_amount_positive', sql`${t.amount} > 0`),
    check('payment_requests_not_self', sql`${t.requesterId} <> ${t.payerId}`),
    index('payment_requests_payer_idx').on(t.payerId, t.status, t.createdAt.desc()),
    index('payment_requests_requester_idx').on(t.requesterId, t.status, t.createdAt.desc()),
    index('payment_requests_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);
