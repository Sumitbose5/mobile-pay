import { boolean, char, check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, sql, ts, updatedAt } from './_helpers.js';
import { walletStatus } from './enums.js';
import { users } from './users.js';

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    isSystem: boolean('is_system').notNull().default(false),
    balance: money('balance').notNull().default(sql`0`),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    status: walletStatus('status').notNull().default('ACTIVE'),
    freezeReason: text('freeze_reason'),
    frozenAt: ts('frozen_at'),
    frozenBy: uuid('frozen_by').references(() => users.id, { onDelete: 'restrict' }),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('wallets_user_id_uq').on(t.userId),
    // Only the platform clearing wallet may go negative (add-money debits it).
    check('wallets_balance_non_negative', sql`${t.balance} >= 0 OR ${t.isSystem}`),
    // A wallet is either owned by a user or is the system wallet, never both/neither.
    check(
      'wallets_owner_xor_system',
      sql`(${t.isSystem} AND ${t.userId} IS NULL) OR (NOT ${t.isSystem} AND ${t.userId} IS NOT NULL)`,
    ),
    // Exactly one system wallet may exist.
    uniqueIndex('wallets_single_system_uq').on(t.isSystem).where(sql`${t.isSystem}`),
    index('wallets_status_idx').on(t.status),
  ],
);

export type Wallet = typeof wallets.$inferSelect;
