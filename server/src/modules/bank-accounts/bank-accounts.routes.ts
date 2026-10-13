import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { addBankAccount, addBankAccountBody, listBankAccounts, removeBankAccount } from './bank-accounts.service.js';

export const bankAccountsRouter = Router();
bankAccountsRouter.use(authenticate);
const ok = <T>(data: T) => ({ success: true, data });

bankAccountsRouter.get('/', asyncHandler(async (req, res) => {
  res.json(ok({ bankAccounts: await listBankAccounts(req.auth!.userId) }));
}));

bankAccountsRouter.post('/', validate({ body: addBankAccountBody }), asyncHandler(async (req, res) => {
  res.status(201).json(ok({ bankAccount: await addBankAccount(req, req.auth!.userId, req.body) }));
}));

bankAccountsRouter.delete('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  await removeBankAccount(req, req.auth!.userId, req.params.id as string);
  res.json(ok({ message: 'Payout account removed' }));
}));
