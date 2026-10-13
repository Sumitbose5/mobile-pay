import { char, index, integer, jsonb, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, ts } from './_helpers.js';
import { idempotencyStatus } from './enums.js';
import { users } from './users.js';

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    key: varchar('key', { length: 100 }).notNull(),
    endpoint: varchar('endpoint', { length: 100 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: idempotencyStatus('status').notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    // The concurrency guard: two parallel requests with the same key cannot both insert.
    uniqueIndex('idempotency_user_key_endpoint_uq').on(t.userId, t.key, t.endpoint),
    index('idempotency_expires_idx').on(t.expiresAt),
  ],
);
