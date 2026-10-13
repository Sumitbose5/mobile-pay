import { bigserial, index, integer, jsonb, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, sql, ts } from './_helpers.js';
import { outboxStatus } from './enums.js';

/**
 * Transactional outbox: rows are written in the same DB transaction as the business change,
 * then a dispatcher publishes them to BullMQ. Guarantees no event for a rolled-back change
 * and no lost event for a committed one.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    aggregateType: varchar('aggregate_type', { length: 50 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: outboxStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.id)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);
