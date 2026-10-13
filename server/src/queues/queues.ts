import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { redisConnectionOptions } from './connection.js';

export const QUEUES = { email: 'email', notifications: 'notifications', maintenance: 'maintenance', payouts: 'payouts', reports: 'reports' } as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const retained: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 }, // failed jobs are the dead-letter set: kept a week for inspection
};

const defaults: Record<QueueName, JobsOptions> = {
  email: { ...retained, attempts: 5, backoff: { type: 'exponential', delay: env.EMAIL_BACKOFF_MS } },
  notifications: { ...retained, attempts: 5, backoff: { type: 'exponential', delay: 500 } },
  maintenance: { ...retained, attempts: 2, backoff: { type: 'fixed', delay: 10_000 } },
  payouts: { ...retained, attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
  reports: { ...retained, attempts: 2, backoff: { type: 'fixed', delay: 5_000 } },
};

const cache = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = cache.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnectionOptions(), prefix: env.QUEUE_PREFIX, defaultJobOptions: defaults[name] });
    cache.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...cache.values()].map((q) => q.close()));
  cache.clear();
}
