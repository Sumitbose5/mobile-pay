import { Router } from 'express';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
  gatewayEventSchema,
  getOrderForUser,
  handleGatewayEvent,
  signPayload,
  toOrderDto,
  verifyWebhookSignature,
} from './payments.service.js';
import { randomToken } from '../../lib/crypto.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { paymentOrders } from '../../db/schema/index.js';

export const paymentsRouter = Router();
const ok = <T>(data: T) => ({ success: true, data });

/** Called by the payment gateway (server to server). Authenticated by HMAC signature, not cookies. */
paymentsRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    verifyWebhookSignature(req.rawBody, req.get('x-gateway-signature'), req.get('x-gateway-timestamp'));
    const event = gatewayEventSchema.parse(req.body);
    const result = await handleGatewayEvent(req, event);
    res.json(ok({ received: true, ...result }));
  }),
);

paymentsRouter.get(
  '/orders/:id',
  authenticate,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    res.json(ok({ order: toOrderDto(await getOrderForUser(req.auth!.userId, req.params.id as string)) }));
  }),
);

/**
 * Stand-in for the hosted gateway page: the "customer" chooses success or failure and the simulator
 * delivers a correctly SIGNED event through the same verification and handler as a real webhook.
 * Disabled in production; replace with Razorpay/Stripe by pointing their webhook at /payments/webhook.
 */
paymentsRouter.post(
  '/simulator/:id/complete',
  authenticate,
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({ outcome: z.enum(['SUCCESS', 'FAILED']) }),
  }),
  asyncHandler(async (req, res) => {
    if (isProd) throw new AppError('RESOURCE_NOT_FOUND', 'Not found');
    const order = await getOrderForUser(req.auth!.userId, req.params.id as string);
    const [fresh] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, order.id));
    const raw = JSON.stringify({
      orderId: fresh!.gatewayOrderId,
      paymentId: `pay_${randomToken(10)}`,
      status: req.body.outcome,
      amount: fresh!.amount.toString(),
      reason: req.body.outcome === 'FAILED' ? 'declined_by_customer' : undefined,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    verifyWebhookSignature(Buffer.from(raw), signPayload(timestamp, raw), timestamp);
    const result = await handleGatewayEvent(req, gatewayEventSchema.parse(JSON.parse(raw)));
    res.json(ok({ result, order: toOrderDto(await getOrderForUser(req.auth!.userId, order.id)) }));
  }),
);
