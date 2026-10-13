import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { cacheKeys, cached } from '../../lib/cache.js';
import { latestReport } from '../reconciliation/reconciliation.store.js';

const istDayStart = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
export const ADMIN_STATS_KEY = 'cache:admin:stats';
export { cacheKeys };

/** Platform statistics for the admin dashboard. A display aggregate: cached for 60 seconds. */
export function adminStats() {
  return cached(ADMIN_STATS_KEY, 60, async () => {
    const [u] = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
             count(*) FILTER (WHERE status = 'PENDING_VERIFICATION')::int AS pending_verification,
             count(*) FILTER (WHERE last_login_at > now() - interval '30 days')::int AS active_30d
      FROM users`)).rows as { total: number; active: number; pending_verification: number; active_30d: number }[];

    const [w] = (await db.execute(sql`
      SELECT coalesce(sum(balance) FILTER (WHERE NOT is_system), 0)::text AS total_balance,
             count(*) FILTER (WHERE status = 'FROZEN')::int AS frozen_wallets
      FROM wallets`)).rows as { total_balance: string; frozen_wallets: number }[];

    const [t] = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
             count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
             count(*) FILTER (WHERE status IN ('PENDING','PROCESSING'))::int AS in_flight,
             coalesce(sum(amount) FILTER (WHERE status = 'SUCCESS' AND type = 'ADD_MONEY'), 0)::text AS add_money_volume,
             coalesce(sum(amount) FILTER (WHERE status = 'SUCCESS' AND type = 'TRANSFER'), 0)::text AS transfer_volume
      FROM transactions WHERE created_at >= ${istDayStart}`)).rows as {
      total: number; successful: number; failed: number; in_flight: number; add_money_volume: string; transfer_volume: string;
    }[];

    const [a] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE severity = 'WARN')::int AS warnings,
             count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical
      FROM audit_logs WHERE created_at > now() - interval '24 hours'`)).rows as { warnings: number; critical: number }[];

    const finished = t!.successful + t!.failed;
    const reconciliation = await latestReport().catch(() => null);
    return {
      generatedAt: new Date().toISOString(),
      users: { total: u!.total, active: u!.active, activeLast30Days: u!.active_30d, pendingVerification: u!.pending_verification },
      wallets: { totalBalance: w!.total_balance, frozen: w!.frozen_wallets },
      today: {
        transactions: t!.total,
        successful: t!.successful,
        failed: t!.failed,
        inFlight: t!.in_flight,
        // percentage of finished transactions that failed, one decimal
        failureRatePercent: finished === 0 ? 0 : Math.round((t!.failed / finished) * 1000) / 10,
        addMoneyVolume: t!.add_money_volume,
        transferVolume: t!.transfer_volume,
      },
      alerts: { warningsLast24h: a!.warnings, criticalLast24h: a!.critical },
      reconciliation: reconciliation ? { ok: reconciliation.ok, ranAt: reconciliation.ranAt } : null,
    };
  });
}
