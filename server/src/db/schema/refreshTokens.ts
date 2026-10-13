import { index, inet, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, ts } from './_helpers.js';
import { users } from './users.js';

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** All tokens descended from one login share a family; reuse of a revoked token revokes it. */
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    deviceInfo: text('device_info'),
    ipAddress: inet('ip_address'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    replacedBy: uuid('replaced_by'),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_user_revoked_idx').on(t.userId, t.revokedAt),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_expires_idx').on(t.expiresAt),
  ],
);
