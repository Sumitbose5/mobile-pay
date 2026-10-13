import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { paiseSchema } from '../../lib/serialize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { limiters } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { createOrder, toOrderDto } from '../payments/payments.service.js';
import { findRecipient, sendMoney } from './transfer.service.js';
import { withdraw } from './withdraw.service.js';
import { getWalletForUser, toWalletDto } from './wallet.service.js';

export const walletRouter = Router();
walletRouter.use(authenticate);
const ok = <T>(data: T) => ({ success: true, data });

walletRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(ok({ wallet: toWalletDto(await getWalletForUser(req.auth!.userId)) }));
  }),
);

// Balance always comes straight from PostgreSQL; money decisions never rely on a cache.
walletRouter.get(
  '/balance',
  asyncHandler(async (req, res) => {
    const w = await getWalletForUser(req.auth!.userId);
    res.json(ok({ balance: w.balance, currency: w.currency, status: w.status }));
  }),
);

walletRouter.post(
  '/add-money',
  limiters.addMoney(),
  validate({ body: z.object({ amount: paiseSchema }) }),
  idempotent('wallet.add-money'),
  asyncHandler(async (req, res) => {
    const order = await createOrder(req, req.auth!.userId, req.body.amount);
    res.status(201).json(ok({ order: toOrderDto(order) }));
  }),
);

const sendBody = z
  .object({
    receiverEmail: z.string().trim().toLowerCase().email().optional(),
    receiverId: z.string().uuid().optional(),
    amount: paiseSchema,
    note: z.string().trim().max(255).optional(),
    pin: z.string().regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits'),
  })
  .refine((v) => Boolean(v.receiverEmail) !== Boolean(v.receiverId), { message: 'Provide either receiverEmail or receiverId' });

walletRouter.post(
  '/send',
  limiters.send(),
  validate({ body: sendBody }),
  idempotent('wallet.send', { ignoreFields: ['pin'] }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof sendBody>;
    const { transaction, receiverName } = await sendMoney(req, req.auth!.userId, {
      receiver: { ...(b.receiverEmail ? { email: b.receiverEmail } : {}), ...(b.receiverId ? { userId: b.receiverId } : {}) },
      amount: b.amount,
      note: b.note,
      pin: b.pin,
    });
    res.status(201).json(
      ok({
        transaction: {
          id: transaction.publicId,
          status: transaction.status,
          amount: transaction.amount,
          receiverName,
          note: transaction.note,
          createdAt: transaction.createdAt,
          completedAt: transaction.completedAt,
        },
      }),
    );
  }),
);

// Lets the UI confirm who will be paid before the user enters a PIN. Rate limited to deter enumeration.
walletRouter.get(
  '/recipients/lookup',
  limiters.lookup(),
  validate({ query: z.object({ email: z.string().trim().toLowerCase().email() }) }),
  asyncHandler(async (req, res) => {
    const r = await findRecipient({ email: req.query.email as string });
    if (r.userId === req.auth!.userId) throw new AppError('VALIDATION_ERROR', 'You cannot send money to yourself');
    res.json(ok({ recipient: { id: r.userId, name: r.name } }));
  }),
);

walletRouter.post(
  '/withdraw',
  limiters.withdraw(),
  validate({
    body: z.object({
      bankAccountId: z.string().uuid(),
      amount: paiseSchema,
      pin: z.string().regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits'),
    }),
  }),
  idempotent('wallet.withdraw', { ignoreFields: ['pin'] }),
  asyncHandler(async (req, res) => {
    const { transaction, destination } = await withdraw(req, req.auth!.userId, req.body);
    res.status(201).json(ok({ transaction: { id: transaction.publicId, status: transaction.status, amount: transaction.amount, destination, createdAt: transaction.createdAt } }));
  }),
);
