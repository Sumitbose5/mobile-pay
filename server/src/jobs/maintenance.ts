import { and, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idempotencyKeys, paymentOrders, refreshTokens, users } from '../db/schema/index.js';
import { logger } from '../lib/logger.js';
import { auditSystem } from '../modules/audit/audit.service.js';
import { reconcile, type ReconciliationReport } from '../modules/reconciliation/reconciliation.service.js';
import { runAndStore } from '../modules/reconciliation/reconciliation.store.js';
import { notice, sendMail } from '../lib/mailer.js';
import { enqueueNotification } from '../queues/jobs.js';

export async function cleanupIdempotencyKeys(): Promise<number> {
  const rows = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date())).returning({ id: idempotencyKeys.id });
  return rows.length;
}

/**
 * Orders nobody paid are marked EXPIRED after a grace period. A gateway confirmation that arrives later is
 * still honoured by the webhook handler, because the money was really captured.
 */
export async function expirePaymentOrders(graceMinutes = 60): Promise<number> {
  const rows = await db
    .update(paymentOrders)
    .set({ status: 'EXPIRED', updatedAt: new Date() })
    .where(and(inArray(paymentOrders.status, ['CREATED', 'PENDING']), sql`${paymentOrders.expiresAt} < now() - make_interval(mins => ${graceMinutes})`))
    .returning({ id: paymentOrders.id });
  return rows.length;
}

/** Expired tokens are useless; revoked ones are kept 30 days so token-reuse investigations still have data. */
export async function cleanupRefreshTokens(): Promise<number> {
  const rows = await db
    .delete(refreshTokens)
    .where(or(lt(refreshTokens.expiresAt, sql`now() - interval '7 days'`), and(isNotNull(refreshTokens.revokedAt), lt(refreshTokens.revokedAt, sql`now() - interval '30 days'`))))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

/**
 * Nightly reconciliation. A failing run raises one in-app notification and one email per active admin
 * (de-duplicated per day) and a CRITICAL audit entry; a passing run is silent apart from the stored report.
 */
export async function runReconciliationJob(run: () => Promise<ReconciliationReport> = runAndStore): Promise<ReconciliationReport> {
  const report = await run();
  if (report.ok) return report;

  const failing = report.checks.filter((c) => !c.ok);
  const summary = failing.map((c) => `${c.name} (${c.violationCount})`).join(', ');
  logger.error({ failing: failing.map((c) => c.name) }, 'Reconciliation found violations');
  await auditSystem({ action: 'RECONCILIATION_FAILED', severity: 'CRITICAL', metadata: { failing: failing.map((c) => ({ name: c.name, count: c.violationCount })) } });

  const admins = await db.select({ id: users.id, email: users.email }).from(users).where(and(inArray(users.role, ['ADMIN']), inArray(users.status, ['ACTIVE'])));
  const day = report.ranAt.slice(0, 10);
  for (const a of admins) {
    await enqueueNotification(
      { userId: a.id, type: 'SYSTEM', title: 'Reconciliation failed', message: `Ledger invariants were violated: ${summary}.`, data: { ranAt: report.ranAt }, dedupeKey: `reconcile-${day}` },
      `reconcile-notify-${day}-${a.id}`,
    );
    await sendMail(notice(a.email, 'CoinHub reconciliation failed', [`The ledger reconciliation found violations: ${summary}.`, 'Open the admin console to investigate.']));
  }
  return report;
}

export { reconcile };
