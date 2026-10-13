import { bigserial, index, inet, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './_helpers.js';
import { auditSeverity } from './enums.js';
import { users } from './users.js';

/** Append-only. UPDATE/DELETE are blocked by a trigger (see custom migration). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    targetUserId: uuid('target_user_id'),
    action: varchar('action', { length: 80 }).notNull(),
    severity: auditSeverity('severity').notNull().default('INFO'),
    entityType: varchar('entity_type', { length: 50 }),
    entityId: uuid('entity_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    requestId: varchar('request_id', { length: 64 }),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('audit_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('audit_action_created_idx').on(t.action, t.createdAt.desc()),
    index('audit_severity_created_idx').on(t.severity, t.createdAt.desc()),
    index('audit_target_created_idx').on(t.targetUserId, t.createdAt.desc()),
  ],
);
