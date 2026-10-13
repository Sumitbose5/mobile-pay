import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import { outboxEvents, paymentOrders, wallets } from '../../db/schema/index.js';
import { cacheKeys, invalidate } from '../../lib/cache.js';
import { randomToken, safeEqual } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { requirePinSet } from '../security/pin.service.js';
import { getNumber } from '../settings/settings.service.js';
import { applyTransfer, getSystemWallet } from '../wallet/ledger.js';
import { getWalletForUser } from '../wallet/wallet.service.js';

const ORDER_TTL_MS = 30 * 60_000;
const SIGNATURE_TOLERANCE_S = 5 * 60;

export function toOrderDto(o: typeof paymentOrders.$inferSelect) {
  return {
    id: o.id,
    gatewayOrderId: o.gatewayOrderId,
    amount: o.amount,
    status: o.status,
    failureReason: o.failureReason,
    expiresAt: o.expiresAt,
    createdAt: o.createdAt,
  };
}

/** Step 1 of add-money: create a gateway order. No money moves until the gateway confirms payment. */
export async function createOrder(req: Request, userId: string, amount: bigint) {
  await requirePinSet(userId);
  const [min, max] = await Promise.all([getNumber('limits.add_money_min'), getNumber('limits.add_money_max')]);
  if (amount < min || amount > max) {
    throw new AppError('LIMIT_EXCEEDED', `Amount must be between ${min / 100n} and ${max / 100n} rupees`);
  }
  const wallet = await getWalletForUser(userId);
  if (wallet.status !== 'ACTIVE') throw new AppError('WALLET_FROZEN', 'Your wallet is not active');
  const maxBalance = await getNumber('limits.max_wallet_balance');
  if (wallet.balance + amount > maxBalance) {
    throw new AppError('LIMIT_EXCEEDED', 'This would exceed the maximum wallet balance');
  }

  const [order] = await db
    .insert(paymentOrders)
    .values({
      userId,
      walletId: wallet.id,
      amount,
      gatewayOrderId: `order_${randomToken(12)}`,
      expiresAt: new Date(Date.now() + ORDER_TTL_MS),
    })
    .returning();
  if (!order) throw new AppError('INTERNAL_ERROR', 'Could not create order');
  await audit(req, { action: 'ADD_MONEY_ORDER_CREATED', entityType: 'payment_order', entityId: order.id, metadata: { amount: amount.toString() } });
  return order;
}

export async function getOrderForUser(userId: string, id: string) {
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).limit(1);
  if (!order || order.userId !== userId) throw new AppError('RESOURCE_NOT_FOUND', 'Order not found');
  return order;
}

// ---------------------------------------------------------------- gateway webhook

export const gatewayEventSchema = z.object({
  orderId: z.string().min(1).max(100),
  paymentId: z.string().min(1).max(100),
  status: z.enum(['SUCCESS', 'FAILED']),
  amount: z.string().regex(/^\d{1,15}$/),
  reason: z.string().max(200).optional(),
});
export type GatewayEvent = z.infer<typeof gatewayEventSchema>;

export const signPayload = (timestamp: string, rawBody: string): string =>
  createHmac('sha256', env.GATEWAY_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');

/** HMAC over "<timestamp>.<raw body>" with a freshness window, so a captured webhook cannot be replayed later. */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined, timestamp: string | undefined): void {
  if (!rawBody || !signature || !timestamp || !/^\d{9,12}$/.test(timestamp)) {
    throw new AppError('UNAUTHORIZED', 'Missing webhook signature');
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) {
    throw new AppError('UNAUTHORIZED', 'Webhook timestamp outside tolerance');
  }
  if (!safeEqual(signature, signPayload(timestamp, rawBody.toString('utf8')))) {
    throw new AppError('UNAUTHORIZED', 'Invalid webhook signature');
  }
}

export type WebhookResult = { duplicate: boolean; status: 'SUCCESS' | 'FAILED' | 'IGNORED'; transactionId?: string; walletId?: string };

/**
 * Applies a gateway payment result. Idempotent: the order row is locked and its status checked,
 * so a webhook delivered twice (or 20 times in parallel) credits the wallet exactly once.
 */
export async function handleGatewayEvent(req: Request, event: GatewayEvent): Promise<WebhookResult> {
  const result = await withTransaction(async (tx): Promise<WebhookResult> => {
    const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.gatewayOrderId, event.orderId)).for('update');
    if (!order) throw new AppError('RESOURCE_NOT_FOUND', 'Unknown order');
    if (order.status === 'SUCCESS' || order.status === 'FAILED') {
      return { duplicate: true, status: 'IGNORED' as const };
    }

    const fail = async (reason: string) => {
      await tx
        .update(paymentOrders)
        .set({ status: 'FAILED', failureReason: reason, gatewayPaymentId: event.paymentId, updatedAt: new Date() })
        .where(eq(paymentOrders.id, order.id));
      return { duplicate: false, status: 'FAILED' as const };
    };

    if (event.status === 'FAILED') return fail(event.reason ?? 'payment_failed');
    if (BigInt(event.amount) !== order.amount) {
      await audit(req, { action: 'GATEWAY_AMOUNT_MISMATCH', userId: order.userId, severity: 'CRITICAL', entityType: 'payment_order', entityId: order.id, metadata: { expected: order.amount.toString(), got: event.amount } }, tx);
      return fail('amount_mismatch');
    }

    const maxBalance = await getNumber('limits.max_wallet_balance');
    try {
      // Savepoint: if crediting is refused, only the credit rolls back and the order can still be marked FAILED.
      const result = await tx.transaction(async (sp) => {
        const system = await getSystemWallet(sp);
        return applyTransfer(sp, {
          type: 'ADD_MONEY',
          senderWalletId: system.id,
          receiverWalletId: order.walletId,
          amount: order.amount,
          initiatedBy: order.userId,
          referenceId: event.paymentId,
          paymentOrderId: order.id,
          requestId: req.id,
          validate: (_sender, receiver) => {
            if (receiver.status !== 'ACTIVE') throw new AppError('WALLET_FROZEN', 'Wallet is not active');
            if (receiver.balance + order.amount > maxBalance) throw new AppError('LIMIT_EXCEEDED', 'Maximum wallet balance exceeded');
          },
        });
      });
      await tx
        .update(paymentOrders)
        .set({ status: 'SUCCESS', gatewayPaymentId: event.paymentId, updatedAt: new Date() })
        .where(eq(paymentOrders.id, order.id));
      // Outbox row commits atomically with the money; a worker (Phase 5) turns it into notifications and email.
      await tx.insert(outboxEvents).values({
        aggregateType: 'transaction',
        aggregateId: result.transaction.id,
        eventType: 'MONEY_ADDED',
        payload: { transactionId: result.transaction.id, publicId: result.transaction.publicId, userId: order.userId, amount: order.amount.toString() },
      });
      await audit(req, { action: 'ADD_MONEY_COMPLETED', userId: order.userId, entityType: 'transaction', entityId: result.transaction.id, metadata: { amount: order.amount.toString() } }, tx);
      return { duplicate: false, status: 'SUCCESS' as const, transactionId: result.transaction.id, walletId: order.walletId };
    } catch (err) {
      if (err instanceof AppError) return fail(err.code.toLowerCase());
      throw err;
    }
  });
  if (result.walletId) await invalidate(cacheKeys.summary(result.walletId));
  return result;
}

export async function walletOwnerOf(walletId: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.id, walletId));
  return w;
}
