import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { outboxEvents } from '../db/schema/index.js';
import { notice } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';
import { enqueueEmail, enqueueNotification, enqueuePayout } from '../queues/jobs.js';
import { effectsFor, emailAllowed } from './events.js';

const MAX_ATTEMPTS = 10;

/**
 * Transactional-outbox dispatcher. Business transactions write an outbox row in the SAME commit as the money,
 * so an event exists if and only if the money moved. This turns committed rows into queue jobs.
 *
 * - `FOR UPDATE SKIP LOCKED`: any number of dispatchers can run; each row is claimed by exactly one at a time.
 * - At-least-once: if the process dies after enqueueing but before marking the row done, the row is sent again.
 *   Job ids derive from the outbox id and the notification has a unique dedupe key, so a repeat has no effect.
 * - A row whose handling keeps failing is retried up to MAX_ATTEMPTS, then parked as FAILED for inspection.
 *
 * Returns how many events were processed.
 */
export async function dispatchOutbox(batchSize = 50): Promise<number> {
  return db.transaction(async (tx) => {
    const batch = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'PENDING'))
      .orderBy(asc(outboxEvents.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    for (const event of batch) {
      try {
        if (event.eventType === 'WITHDRAWAL_REQUESTED') await enqueuePayout((event.payload as { transactionId: string }).transactionId);
        const effects = await effectsFor(event);
        for (const [i, e] of effects.entries()) {
          const key = `${event.id}-${i}`;
          await enqueueNotification(
            { userId: e.userId, type: e.notification.type, title: e.notification.title, message: e.notification.message, data: e.notification.data, dedupeKey: `outbox-${key}` },
            `notify-${key}`,
          );
          const mail = await emailAllowed(e.userId, e.email.category);
          if (mail.allowed && mail.to) await enqueueEmail(notice(mail.to, e.email.subject, e.email.lines), `mail-${key}`);
        }
        await tx.update(outboxEvents).set({ status: 'PROCESSED', processedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` }).where(eq(outboxEvents.id, event.id));
      } catch (err) {
        const attempts = event.attempts + 1;
        logger.error({ err, outboxId: String(event.id), attempts }, 'Outbox event failed');
        await tx.update(outboxEvents).set({ attempts, status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING' }).where(eq(outboxEvents.id, event.id));
      }
    }
    return batch.length;
  });
}

/** Polls until stopped; sleeps `idleMs` when there is nothing to do, loops immediately while there is a backlog. */
export function startOutboxLoop(idleMs: number): () => Promise<void> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      let n = 0;
      try {
        n = await dispatchOutbox();
      } catch (err) {
        logger.error({ err }, 'Outbox dispatch cycle failed');
      }
      if (n === 0) await new Promise((r) => setTimeout(r, idleMs));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}
