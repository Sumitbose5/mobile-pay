import { and, count, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { db } from '../../db/client.js';
import { transactions } from '../../db/schema/index.js';
import { logger } from '../../lib/logger.js';
import { getRedis } from '../../redis/client.js';
import { audit } from '../audit/audit.service.js';
import { getNumber } from '../settings/settings.service.js';

export interface TransferFacts {
  userId: string;
  receiverUserId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amount: bigint;
  transactionId: string;
  publicId: string;
}

export type Rule = 'HIGH_VELOCITY' | 'LARGE_AMOUNT' | 'NEW_PAYEE_LARGE_AMOUNT';

/**
 * Flags suspicious transfers for admin review. It runs AFTER the transfer has committed and only writes audit entries:
 * a rule can never block, delay or roll back a payment (a false positive must not cost an honest user money), and a
 * failure here is logged and swallowed. Thresholds live in system_settings.
 *
 *  - HIGH_VELOCITY: many transfers from one wallet inside a short window (flagged once per window per user)
 *  - LARGE_AMOUNT: a single transfer at or above the large-amount threshold
 *  - NEW_PAYEE_LARGE_AMOUNT: the first transfer ever to this recipient is already a large one
 */
export async function flagSuspiciousTransfer(req: Request, f: TransferFacts): Promise<Rule[]> {
  const flagged: { rule: Rule; detail: Record<string, unknown> }[] = [];
  try {
    const [velocityCount, windowSeconds, large, newPayee] = await Promise.all([
      getNumber('fraud.velocity_count'),
      getNumber('fraud.velocity_window_seconds'),
      getNumber('fraud.large_amount'),
      getNumber('fraud.new_payee_amount'),
    ]);

    const [recent] = await db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.senderWalletId, f.senderWalletId), eq(transactions.type, 'TRANSFER'), eq(transactions.status, 'SUCCESS'), sql`${transactions.createdAt} > now() - make_interval(secs => ${Number(windowSeconds)})`));
    if (BigInt(recent?.n ?? 0) >= velocityCount) {
      // One flag per window per user, so a burst of 200 transfers is one alert, not 200.
      const first = await getRedis().set(`fraud:velocity:${f.userId}`, '1', 'EX', Number(windowSeconds), 'NX');
      if (first) flagged.push({ rule: 'HIGH_VELOCITY', detail: { transfers: recent?.n, windowSeconds: Number(windowSeconds) } });
    }

    if (f.amount >= large) flagged.push({ rule: 'LARGE_AMOUNT', detail: { threshold: large.toString() } });

    if (f.amount >= newPayee) {
      const [prior] = await db
        .select({ n: count() })
        .from(transactions)
        .where(and(eq(transactions.senderWalletId, f.senderWalletId), eq(transactions.receiverWalletId, f.receiverWalletId), eq(transactions.type, 'TRANSFER'), eq(transactions.status, 'SUCCESS')));
      if ((prior?.n ?? 0) <= 1) flagged.push({ rule: 'NEW_PAYEE_LARGE_AMOUNT', detail: { threshold: newPayee.toString() } });
    }

    for (const { rule, detail } of flagged) {
      await audit(req, {
        action: 'SUSPICIOUS_ACTIVITY',
        severity: 'WARN',
        userId: f.userId,
        targetUserId: f.receiverUserId,
        entityType: 'transaction',
        entityId: f.transactionId,
        metadata: { rule, publicId: f.publicId, amount: f.amount.toString(), ...detail },
      });
    }
  } catch (err) {
    logger.error({ err }, 'Fraud rule evaluation failed');
  }
  return flagged.map((x) => x.rule);
}
