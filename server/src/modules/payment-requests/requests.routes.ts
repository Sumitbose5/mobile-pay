import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { paiseSchema } from '../../lib/serialize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { limiters } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { cancelRequest, createRequest, getRequest, listQuery, listRequests, payRequest, rejectRequest } from './requests.service.js';

export const paymentRequestsRouter = Router();
paymentRequestsRouter.use(authenticate);
const ok = <T>(data: T) => ({ success: true, data });
const idParams = z.object({ id: z.string().uuid() });

paymentRequestsRouter.post(
  '/',
  limiters.send(),
  validate({ body: z.object({ payerEmail: z.string().trim().toLowerCase().email(), amount: paiseSchema, note: z.string().trim().max(255).optional() }) }),
  asyncHandler(async (req, res) => {
    const created = await createRequest(req, req.auth!.userId, req.body);
    res.status(201).json(ok({ request: await getRequest(req.auth!.userId, created.id) }));
  }),
);

paymentRequestsRouter.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(ok(await listRequests(req.auth!.userId, listQuery.parse(req.query))));
}));

paymentRequestsRouter.get('/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(ok({ request: await getRequest(req.auth!.userId, req.params.id as string) }));
}));

paymentRequestsRouter.post(
  '/:id/pay',
  limiters.send(),
  validate({ params: idParams, body: z.object({ pin: z.string().regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits') }) }),
  idempotent('payment-requests.pay', { ignoreFields: ['pin'] }),
  asyncHandler(async (req, res) => {
    const { request, transaction } = await payRequest(req, req.auth!.userId, req.params.id as string, req.body.pin);
    res.status(201).json(ok({ request, transaction: { id: transaction.publicId, status: transaction.status, amount: transaction.amount } }));
  }),
);

paymentRequestsRouter.post('/:id/reject', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(ok({ request: await rejectRequest(req, req.auth!.userId, req.params.id as string) }));
}));

paymentRequestsRouter.post('/:id/cancel', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(ok({ request: await cancelRequest(req, req.auth!.userId, req.params.id as string) }));
}));
