import type { MailMessage } from '../lib/mailer.js';
import { env } from '../config/env.js';
import { getQueue, QUEUES } from './queues.js';

export interface NotificationJob {
  userId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  /** Unique per (user, source event): a redelivered job cannot create a second notification. */
  dedupeKey: string;
}

// BullMQ custom job ids may not contain ':'.
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '-');

export const enqueueEmail = (message: MailMessage, jobId?: string) =>
  getQueue(QUEUES.email).add('send-email', { message }, jobId ? { jobId: safeId(jobId) } : {});

export const enqueueNotification = (job: NotificationJob, jobId?: string) =>
  getQueue(QUEUES.notifications).add('send-notification', job, jobId ? { jobId: safeId(jobId) } : {});

/** The delay stands in for bank latency; the job id makes enqueueing twice harmless. */
export const enqueuePayout = (transactionId: string) =>
  getQueue(QUEUES.payouts).add('process-payout', { transactionId }, { jobId: safeId(`payout-${transactionId}`), delay: env.PAYOUT_DELAY_MS });

export const enqueueReport = (reportId: string) =>
  getQueue(QUEUES.reports).add('generate-report', { reportId }, { jobId: safeId(`report-${reportId}`) });
