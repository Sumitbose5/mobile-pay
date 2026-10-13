import { closeDb } from './db/client.js';
import { logger } from './lib/logger.js';
import { startBackgroundJobs } from './jobs/workers.js';
import { closeQueues } from './queues/queues.js';
import { closeRedis } from './redis/client.js';

/** Separate process from the API: scale it, restart it and deploy it independently. */
const jobs = startBackgroundJobs();
logger.info('CoinHub worker started (email, notifications, maintenance, outbox dispatcher)');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Worker shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await jobs.stop(); // lets in-flight jobs finish
  await Promise.allSettled([closeQueues(), closeDb(), closeRedis()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
