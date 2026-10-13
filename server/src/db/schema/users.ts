import { index, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, money, sql, ts, updatedAt } from './_helpers.js';
import { userRole, userStatus } from './enums.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('USER'),
    status: userStatus('status').notNull().default('PENDING_VERIFICATION'),
    emailVerifiedAt: ts('email_verified_at'),
    transactionPinHash: text('transaction_pin_hash'),
    pinSetAt: ts('pin_set_at'),
    twoFactorSecret: text('two_factor_secret'),
    dailyLimitOverride: money('daily_limit_override'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    index('users_status_created_idx').on(t.status, t.createdAt),
    index('users_role_idx').on(t.role),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
