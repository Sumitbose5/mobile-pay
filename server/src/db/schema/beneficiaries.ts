import { check, index, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, sql, ts } from './_helpers.js';
import { users } from './users.js';

export const beneficiaries = pgTable(
  'beneficiaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    beneficiaryUserId: uuid('beneficiary_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    nickname: varchar('nickname', { length: 100 }),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('beneficiaries_not_self', sql`${t.ownerId} <> ${t.beneficiaryUserId}`),
    uniqueIndex('beneficiaries_owner_beneficiary_uq')
      .on(t.ownerId, t.beneficiaryUserId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('beneficiaries_owner_idx').on(t.ownerId),
  ],
);
