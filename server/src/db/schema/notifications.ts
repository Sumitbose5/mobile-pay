import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, sql, ts } from './_helpers.js';
import { notificationType } from './enums.js';
import { users } from './users.js';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationType('type').notNull(),
    title: varchar('title', { length: 150 }).notNull(),
    message: text('message').notNull(),
    data: jsonb('data'),
    /** Source-event identity; with the unique index below, redelivered jobs cannot create duplicates. */
    dedupeKey: varchar('dedupe_key', { length: 120 }),
    isRead: boolean('is_read').notNull().default(false),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_user_dedupe_uq')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('notifications_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_user_unread_idx')
      .on(t.userId)
      .where(sql`${t.isRead} = false`),
  ],
);
