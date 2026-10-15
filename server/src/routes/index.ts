import { Router } from 'express';
import { csrfProtection } from '../middleware/csrf.js';
import { limiters } from '../middleware/rateLimit.js';
import { adminRouter } from '../modules/admin/admin.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { bankAccountsRouter } from '../modules/bank-accounts/bank-accounts.routes.js';
import { beneficiariesRouter } from '../modules/beneficiaries/beneficiaries.routes.js';
import { notificationsRouter } from '../modules/notifications/notifications.routes.js';
import { paymentRequestsRouter } from '../modules/payment-requests/requests.routes.js';
import { paymentsRouter } from '../modules/payments/payments.routes.js';
import { transactionsRouter } from '../modules/transactions/transactions.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';
import { walletRouter } from '../modules/wallet/wallet.routes.js';

/**
 * Module routers are mounted here as each phase lands:
 *   Phase 1: auth, users, admin(skeleton)   Phase 2: wallet, payments   Phase 3: transactions
 *   Phase 6: beneficiaries, payment-requests, notifications, bank-accounts   Phase 7: admin
 */
export const apiRouter = Router();

apiRouter.use(limiters.global());
// apiRouter.use(csrfProtection);

apiRouter.get('/', (_req, res) => {
  res.json({ success: true, data: { name: 'CoinHub API', version: 'v1' } });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/wallet', walletRouter);
apiRouter.use('/transactions', transactionsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/beneficiaries', beneficiariesRouter);
apiRouter.use('/bank-accounts', bankAccountsRouter);
apiRouter.use('/payment-requests', paymentRequestsRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/admin', adminRouter);
