import { index, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { check } from 'drizzle-orm/pg-core';
import { createdAt, money, sql, ts, updatedAt } from './_helpers.js';
import { paymentOrderStatus } from './enums.js';
import { users } from './users.js';
import { wallets } from './wallets.js';

export const paymentOrders = pgTable(
  'payment_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    status: paymentOrderStatus('status').notNull().default('CREATED'),
    gatewayOrderId: varchar('gateway_order_id', { length: 100 }).notNull(),
    gatewayPaymentId: varchar('gateway_payment_id', { length: 100 }),
    gatewaySignature: text('gateway_signature'),
    failureReason: text('failure_reason'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('payment_orders_amount_positive', sql`${t.amount} > 0`),
    uniqueIndex('payment_orders_gateway_order_uq').on(t.gatewayOrderId),
    // Webhook idempotency: one gateway payment can credit a wallet only once.
    uniqueIndex('payment_orders_gateway_payment_uq').on(t.gatewayPaymentId),
    index('payment_orders_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('payment_orders_status_expires_idx').on(t.status, t.expiresAt),
  ],
);
