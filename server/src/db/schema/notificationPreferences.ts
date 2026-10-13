import { boolean, pgTable, uuid } from 'drizzle-orm/pg-core';
import { updatedAt } from './_helpers.js';
import { users } from './users.js';

/** Security emails are always sent and are intentionally not configurable. */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  emailMoneyReceived: boolean('email_money_received').notNull().default(true),
  emailMoneySent: boolean('email_money_sent').notNull().default(true),
  emailPaymentRequests: boolean('email_payment_requests').notNull().default(true),
  emailMarketing: boolean('email_marketing').notNull().default(false),
  updatedAt: updatedAt(),
});
