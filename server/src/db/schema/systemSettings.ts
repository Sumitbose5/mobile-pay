import { jsonb, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { updatedAt } from './_helpers.js';

export const systemSettings = pgTable('system_settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});
