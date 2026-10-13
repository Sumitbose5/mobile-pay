import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { authenticate, requireActiveAdmin } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../audit/audit.service.js';
import { latestReport, runAndStore } from '../reconciliation/reconciliation.store.js';
import { reverseTransaction } from '../wallet/reversal.service.js';
import { adminGetTransaction, adminListAudit, adminListTransactions, auditQuery, txnQuery } from './monitoring.service.js';
import { adminStats } from './stats.service.js';
import { forceLogout, freezeUser, getUserDetail, listUsers, unfreezeUser, userListQuery } from './users.service.js';
import { getQueue, QUEUES } from '../../queues/queues.js';

/** Every admin route sits behind authentication AND a server-side role check. Phase 7 adds the rest of the console. */
export const adminRouter = Router();
// requireActiveAdmin re-reads role and status from the database, so demotion or suspension is immediate.
adminRouter.use(authenticate, requireActiveAdmin);
const ok = <T>(data: T) => ({ success: true, data });

// Read-only queue dashboard (jobs, failures, retries). Mutations are disabled; use the CLI or Phase 7 console for those.
// Built on first use so merely creating the app never opens queue connections.
let queueBoard: ExpressAdapter | undefined;
adminRouter.use('/queues', (req, res, next) => {
  if (!queueBoard) {
    queueBoard = new ExpressAdapter();
    queueBoard.setBasePath('/api/v1/admin/queues');
    createBullBoard({
      queues: Object.values(QUEUES).map((name) => new BullMQAdapter(getQueue(name), { readOnlyMode: true })),
      serverAdapter: queueBoard,
    });
  }
  queueBoard.getRouter()(req, res, next);
});

adminRouter.get('/ping', (_req, res) => {
  res.json(ok({ admin: true }));
});

adminRouter.post(
  '/transactions/:id/reverse',
  validate({
    params: z.object({ id: z.string().regex(/^TXN_[0-9A-Z]{12}$/) }),
    body: z.object({ reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const { reversal, original } = await reverseTransaction(req, req.auth!.userId, req.params.id as string, req.body.reason);
    res.status(201).json(ok({ reversal: { id: reversal.publicId, status: reversal.status, amount: reversal.amount, reversalOf: original.publicId } }));
  }),
);

adminRouter.get(
  '/reconciliation',
  asyncHandler(async (_req, res) => {
    res.json(ok({ report: await latestReport() }));
  }),
);

adminRouter.post(
  '/reconciliation/run',
  asyncHandler(async (req, res) => {
    const report = await runAndStore();
    await audit(req, { action: 'RECONCILIATION_RUN', severity: report.ok ? 'INFO' : 'CRITICAL', metadata: { ok: report.ok, failing: report.checks.filter((c) => !c.ok).map((c) => c.name) } });
    res.json(ok({ report }));
  }),
);

adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  res.json(ok({ stats: await adminStats() }));
}));

// ---- users
const userIdParams = z.object({ id: z.string().uuid() });

adminRouter.get('/users', validate({ query: userListQuery }), asyncHandler(async (req, res) => {
  res.json(ok(await listUsers(userListQuery.parse(req.query))));
}));

adminRouter.get('/users/:id', validate({ params: userIdParams }), asyncHandler(async (req, res) => {
  res.json(ok(await getUserDetail(req, req.auth!.userId, req.params.id as string)));
}));

adminRouter.post(
  '/users/:id/freeze',
  validate({ params: userIdParams, body: z.object({ reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(200) }) }),
  asyncHandler(async (req, res) => {
    res.json(ok({ user: await freezeUser(req, req.auth!.userId, req.params.id as string, req.body.reason) }));
  }),
);

adminRouter.post('/users/:id/unfreeze', validate({ params: userIdParams }), asyncHandler(async (req, res) => {
  res.json(ok({ user: await unfreezeUser(req, req.auth!.userId, req.params.id as string) }));
}));

adminRouter.post('/users/:id/force-logout', validate({ params: userIdParams }), asyncHandler(async (req, res) => {
  await forceLogout(req, req.auth!.userId, req.params.id as string);
  res.json(ok({ message: 'User signed out of all devices' }));
}));

// ---- transactions
adminRouter.get('/transactions', validate({ query: txnQuery }), asyncHandler(async (req, res) => {
  res.json(ok(await adminListTransactions(txnQuery.parse(req.query))));
}));

adminRouter.get(
  '/transactions/:id',
  validate({ params: z.object({ id: z.string().regex(/^TXN_[0-9A-Z]{12}$/) }) }),
  asyncHandler(async (req, res) => {
    res.json(ok({ transaction: await adminGetTransaction(req.params.id as string) }));
  }),
);

// ---- audit log and suspicious activity
adminRouter.get('/audit-logs', validate({ query: auditQuery }), asyncHandler(async (req, res) => {
  res.json(ok(await adminListAudit(auditQuery.parse(req.query))));
}));

adminRouter.get('/suspicious', validate({ query: auditQuery }), asyncHandler(async (req, res) => {
  res.json(ok(await adminListAudit(auditQuery.parse(req.query), { suspiciousOnly: true })));
}));
