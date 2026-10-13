import { logger } from './logger.js';
import { getRedis } from '../redis/client.js';

/**
 * Read-through cache for DISPLAY data only (profile, summaries). Money decisions never read from here:
 * balances and limits always come straight from PostgreSQL under a lock.
 * A Redis failure degrades to "no cache"; it must never break a request.
 */
export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn({ err, key }, 'Cache read failed');
  }
  const value = await loader();
  try {
    // bigint money values are stored as the integer strings the API would have sent anyway
    await redis.set(key, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'Cache write failed');
  }
  return value;
}

export async function invalidate(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch (err) {
    logger.warn({ err, keys }, 'Cache invalidation failed');
  }
}

export const cacheKeys = {
  user: (userId: string) => `cache:user:${userId}`,
  summary: (walletId: string) => `cache:summary:${walletId}`,
  unread: (userId: string) => `cache:unread:${userId}`,
};
