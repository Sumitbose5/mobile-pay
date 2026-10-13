import { sql } from 'drizzle-orm';
import { bigint, timestamp } from 'drizzle-orm/pg-core';

/** Money column: integer paise stored as BIGINT, surfaced to JS as bigint. */
export const money = (name: string) => bigint(name, { mode: 'bigint' });

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const ts = (name: string) => timestamp(name, { withTimezone: true });

export { sql };
