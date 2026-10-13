import { bigserial, check, index, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, sql } from './_helpers.js';
import { ledgerEntryType } from './enums.js';
import { transactions } from './transactions.js';
import { wallets } from './wallets.js';

/** Append-only. UPDATE/DELETE are blocked by a trigger (see custom migration). */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    type: ledgerEntryType('type').notNull(),
    amount: money('amount').notNull(),
    balanceBefore: money('balance_before').notNull(),
    balanceAfter: money('balance_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ledger_amount_positive', sql`${t.amount} > 0`),
    check(
      'ledger_balance_math',
      sql`(${t.type} = 'CREDIT' AND ${t.balanceAfter} = ${t.balanceBefore} + ${t.amount})
        OR (${t.type} = 'DEBIT' AND ${t.balanceAfter} = ${t.balanceBefore} - ${t.amount})`,
    ),
    uniqueIndex('ledger_txn_wallet_type_uq').on(t.transactionId, t.walletId, t.type),
    index('ledger_wallet_created_idx').on(t.walletId, t.createdAt.desc()),
    index('ledger_transaction_idx').on(t.transactionId),
  ],
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
