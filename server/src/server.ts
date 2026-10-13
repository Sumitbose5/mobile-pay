import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDb } from './db/client.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './queues/queues.js';
import { closeRedis } from './redis/client.js';
import { startBackgroundJobs, type BackgroundJobs } from './jobs/workers.js';

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`CoinHub API listening on :${env.PORT} (${env.NODE_ENV})`);
});

let jobs: BackgroundJobs | undefined;
if (env.NODE_ENV === 'development' && process.env.STANDALONE_WORKER !== 'true') {
  jobs = startBackgroundJobs();
  logger.info('Development background worker started in server (email, notifications, outbox)');
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  if (jobs) {
    try {
      await jobs.stop();
    } catch {
      // ignore
    }
  }
  server.close(async () => {
    await Promise.allSettled([closeQueues(), closeDb(), closeRedis()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
