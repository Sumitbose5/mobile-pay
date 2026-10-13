import { Worker, type Job } from 'bullmq';
import { env, isTest } from '../config/env.js';
import { deliverMail, recordDelivered, type MailMessage } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';
import { generateReport } from '../modules/transactions/reports.service.js';
import { expireRequests } from '../modules/payment-requests/requests.service.js';
import { processPayout } from '../modules/wallet/withdraw.service.js';
import { createNotification } from '../modules/notifications/notifications.service.js';
import { redisConnectionOptions } from '../queues/connection.js';
import type { NotificationJob } from '../queues/jobs.js';
import { getQueue, QUEUES } from '../queues/queues.js';
import { startOutboxLoop } from './outbox.js';
import { cleanupIdempotencyKeys, cleanupRefreshTokens, expirePaymentOrders, runReconciliationJob } from './maintenance.js';

const opts = (concurrency: number) => ({ connection: redisConnectionOptions(), prefix: env.QUEUE_PREFIX, concurrency });

/** Registers the repeatable jobs. Safe to call on every start: the scheduler id makes it an upsert. */
export async function registerSchedules(): Promise<void> {
  const q = getQueue(QUEUES.maintenance);
  await q.upsertJobScheduler('cleanup-idempotency-keys', { every: 60 * 60_000 }, { name: 'cleanup-idempotency-keys' });
  await q.upsertJobScheduler('expire-payment-orders', { every: 5 * 60_000 }, { name: 'expire-payment-orders' });
  await q.upsertJobScheduler('cleanup-expired-requests', { every: 5 * 60_000 }, { name: 'cleanup-expired-requests' });
  await q.upsertJobScheduler('cleanup-refresh-tokens', { pattern: '0 3 * * *', tz: 'Asia/Kolkata' }, { name: 'cleanup-refresh-tokens' });
  await q.upsertJobScheduler('reconcile-ledger', { pattern: '0 2 * * *', tz: 'Asia/Kolkata' }, { name: 'reconcile-ledger' });
}

export interface BackgroundJobs {
  stop: () => Promise<void>;
}

/** Starts the email, notification and maintenance workers plus the outbox dispatcher loop. */
export function startBackgroundJobs(options: { outbox?: boolean } = {}): BackgroundJobs {
  const email = new Worker<{ message: MailMessage }>(
    QUEUES.email,
    async (job: Job<{ message: MailMessage }>) => {
      await deliverMail(job.data.message); // throws on SMTP failure -> BullMQ retries with exponential backoff
      recordDelivered(job.data.message);
    },
    opts(5),
  );
  const notifications = new Worker<NotificationJob>(
    QUEUES.notifications,
    async (job: Job<NotificationJob>) => {
      await createNotification(job.data);
    },
    opts(10),
  );
  const maintenance = new Worker(
    QUEUES.maintenance,
    async (job: Job) => {
      switch (job.name) {
        case 'cleanup-idempotency-keys': return { deleted: await cleanupIdempotencyKeys() };
        case 'expire-payment-orders': return { expired: await expirePaymentOrders() };
        case 'cleanup-expired-requests': return { expired: await expireRequests() };
        case 'cleanup-refresh-tokens': return { deleted: await cleanupRefreshTokens() };
        case 'reconcile-ledger': return { ok: (await runReconciliationJob()).ok };
        default: throw new Error(`Unknown maintenance job: ${job.name}`);
      }
    },
    opts(1),
  );

  // Payouts are idempotent (the transaction row is locked and only a PROCESSING one is touched), so retries are safe.
  const payouts = new Worker<{ transactionId: string }>(QUEUES.payouts, async (job: Job<{ transactionId: string }>) => ({ outcome: await processPayout(job.data.transactionId) }), opts(3));
  const reports = new Worker<{ reportId: string }>(QUEUES.reports, async (job: Job<{ reportId: string }>) => { await generateReport(job.data.reportId); }, opts(2));

  for (const w of [email, notifications, maintenance, payouts, reports]) {
    w.on('failed', (job, err) => {
      const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      logger[final ? 'error' : 'warn']({ queue: w.name, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, final ? 'Job failed permanently' : 'Job failed, will retry');
    });
    w.on('error', (err) => logger.error({ err, queue: w.name }, 'Worker error'));
  }

  const stopOutbox = options.outbox === false ? async () => {} : startOutboxLoop(env.OUTBOX_POLL_MS);
  if (!isTest) void registerSchedules().catch((err) => logger.error({ err }, 'Could not register schedules'));

  return {
    stop: async () => {
      await stopOutbox();
      await Promise.allSettled([email.close(), notifications.close(), maintenance.close(), payouts.close(), reports.close()]);
    },
  };
}
