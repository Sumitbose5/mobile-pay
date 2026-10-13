import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { limiters } from '../../middleware/rateLimit.js';
import { exportBody, getReportFile, getReportStatus, requestExport } from './reports.service.js';
import { getTransaction, listQuery, listTransactions, monthlySummary } from './transactions.service.js';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);
const ok = <T>(data: T) => ({ success: true, data });

transactionsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    // validate() has already coerced and defaulted the query; parse again for a typed value.
    res.json(ok(await listTransactions(req.auth!.userId, listQuery.parse(req.query))));
  }),
);

const reportParams = z.object({ id: z.string().uuid() });

// Statement export runs in the worker: request it, poll its status, then download the CSV.
transactionsRouter.post(
  '/export',
  limiters.export(),
  validate({ body: exportBody }),
  asyncHandler(async (req, res) => {
    res.status(202).json(ok({ report: await requestExport(req.auth!.userId, req.body) }));
  }),
);

transactionsRouter.get(
  '/export/:id',
  validate({ params: reportParams }),
  asyncHandler(async (req, res) => {
    res.json(ok({ report: await getReportStatus(req.auth!.userId, req.params.id as string) }));
  }),
);

transactionsRouter.get(
  '/export/:id/download',
  validate({ params: reportParams }),
  asyncHandler(async (req, res) => {
    const { filename, csv } = await getReportFile(req.auth!.userId, req.params.id as string);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }),
);

transactionsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json(ok({ summary: await monthlySummary(req.auth!.userId) }));
  }),
);

transactionsRouter.get(
  '/:id',
  validate({ params: z.object({ id: z.string().regex(/^TXN_[0-9A-Z]{12}$/, 'Invalid transaction id') }) }),
  asyncHandler(async (req, res) => {
    res.json(ok({ transaction: await getTransaction(req.auth!.userId, req.params.id as string) }));
  }),
);
