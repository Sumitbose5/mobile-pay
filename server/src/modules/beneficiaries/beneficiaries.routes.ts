import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { addBeneficiary, listBeneficiaries, removeBeneficiary, renameBeneficiary } from './beneficiaries.service.js';

export const beneficiariesRouter = Router();
beneficiariesRouter.use(authenticate);
const ok = <T>(data: T) => ({ success: true, data });
const idParams = z.object({ id: z.string().uuid() });
const nickname = z.string().trim().max(100);

beneficiariesRouter.get('/', asyncHandler(async (req, res) => {
  res.json(ok({ beneficiaries: await listBeneficiaries(req.auth!.userId) }));
}));

beneficiariesRouter.post(
  '/',
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), nickname: nickname.optional(), pin: z.string().regex(/^(\d{4}|\d{6})$/) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(ok({ beneficiary: await addBeneficiary(req, req.auth!.userId, req.body) }));
  }),
);

beneficiariesRouter.patch(
  '/:id',
  validate({ params: idParams, body: z.object({ nickname: nickname.nullable() }) }),
  asyncHandler(async (req, res) => {
    res.json(ok({ beneficiary: await renameBeneficiary(req.auth!.userId, req.params.id as string, req.body.nickname || null) }));
  }),
);

beneficiariesRouter.delete(
  '/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await removeBeneficiary(req, req.auth!.userId, req.params.id as string);
    res.json(ok({ message: 'Beneficiary removed' }));
  }),
);
