import { boolean, index, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, ts } from './_helpers.js';
import { users } from './users.js';

/** Destinations for simulated withdrawals. Only masked identifiers are stored. */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    holderName: varchar('holder_name', { length: 100 }).notNull(),
    accountLast4: varchar('account_last4', { length: 4 }),
    upiIdMasked: varchar('upi_id_masked', { length: 100 }),
    ifsc: varchar('ifsc', { length: 11 }),
    isVerified: boolean('is_verified').notNull().default(false),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('bank_accounts_user_idx').on(t.userId)],
);
