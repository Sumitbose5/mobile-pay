import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { notifications } from '../../db/schema/index.js';
import { cached, cacheKeys, invalidate } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import type { NotificationJob } from '../../queues/jobs.js';

export const listQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const [ts, id] = z.tuple([z.string(), z.string().uuid()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return [ts, id];
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
  }
}

const toDto = (n: typeof notifications.$inferSelect) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  message: n.message,
  data: n.data,
  isRead: n.isRead,
  createdAt: n.createdAt,
});

/** Used by the notification worker. Idempotent: a redelivered job hits the unique dedupe key and does nothing. */
export async function createNotification(job: NotificationJob): Promise<boolean> {
  const inserted = await db
    .insert(notifications)
    .values({
      userId: job.userId,
      type: job.type as typeof notifications.$inferInsert.type,
      title: job.title,
      message: job.message,
      data: job.data ?? null,
      dedupeKey: job.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (inserted.length > 0) await invalidate(cacheKeys.unread(job.userId));
  return inserted.length > 0;
}

export async function listNotifications(userId: string, q: z.infer<typeof listQuery>) {
  const filters: (SQL | undefined)[] = [eq(notifications.userId, userId)];
  if (q.unread === 'true') filters.push(eq(notifications.isRead, false));
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    filters.push(sql`(${notifications.createdAt}, ${notifications.id}) < (${ts}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db
    .select({ n: notifications, ts: sql<string>`${notifications.createdAt}::text` })
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => toDto(r.n)), nextCursor: rows.length > q.limit && last ? encodeCursor(last.ts, last.n.id) : null };
}

/** Cached for 5 minutes and invalidated whenever a notification is created or read. */
export const unreadCount = (userId: string): Promise<number> =>
  cached(cacheKeys.unread(userId), 300, async () => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
    return row?.n ?? 0;
  });

export async function markRead(userId: string, id: string): Promise<void> {
  const [row] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', 'Notification not found');
  await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.isRead, false)));
  await invalidate(cacheKeys.unread(userId));
}

export async function markAllRead(userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)))
    .returning({ id: notifications.id });
  await invalidate(cacheKeys.unread(userId));
  return rows.length;
}
