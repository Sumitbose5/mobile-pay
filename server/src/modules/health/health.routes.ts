import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { getRedis } from '../../redis/client.js';

export const healthRouter = Router();

const PROBE_TIMEOUT_MS = 2_000;

/** A dependency that hangs must report "down", not hang the readiness probe. */
async function probe(fn: () => Promise<boolean>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([fn().catch(() => false), timeout])) ? 'up' : 'down';
  } finally {
    clearTimeout(timer);
  }
}

// Liveness: the process is up.
healthRouter.get('/live', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// Readiness: dependencies reachable.
healthRouter.get('/ready', async (_req, res) => {
  const [database, redis] = await Promise.all([
    probe(async () => {
      await db.execute(sql`select 1`);
      return true;
    }),
    probe(async () => (await getRedis().ping()) === 'PONG'),
  ]);
  const checks = { database, redis };
  const ok = database === 'up' && redis === 'up';
  res.status(ok ? 200 : 503).json({ success: ok, data: { status: ok ? 'ready' : 'degraded', checks } });
});
