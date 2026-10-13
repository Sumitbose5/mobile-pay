import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { issueCsrfToken } from '../../middleware/csrf.js';
import { limiters } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as schemas from './auth.schemas.js';
import * as auth from './auth.service.js';

export const authRouter = Router();
const ok = <T>(data: T) => ({ success: true, data });
const accepted = (message: string) => ok({ message });

// Issues the CSRF cookie + token for the SPA to echo in the x-csrf-token header.
authRouter.get('/csrf', (_req, res) => {
  res.json(ok({ csrfToken: issueCsrfToken(res) }));
});

authRouter.post(
  '/register',
  limiters.register(),
  validate({ body: schemas.registerBody }),
  asyncHandler(async (req, res) => {
    await auth.register(req, req.body);
    res.status(202).json(accepted('If the email can be used, a verification link has been sent.'));
  }),
);

authRouter.post(
  '/verify-email',
  validate({ body: schemas.tokenBody }),
  asyncHandler(async (req, res) => {
    await auth.verifyEmail(req, req.body.token);
    res.json(accepted('Email verified. You can now log in.'));
  }),
);

authRouter.post(
  '/resend-verification',
  limiters.resendVerification(),
  validate({ body: schemas.emailBody }),
  asyncHandler(async (req, res) => {
    await auth.resendVerification(req, req.body.email);
    res.status(202).json(accepted('If the account is awaiting verification, a new link has been sent.'));
  }),
);

authRouter.post(
  '/login',
  limiters.login(),
  validate({ body: schemas.loginBody }),
  asyncHandler(async (req, res) => {
    const user = await auth.login(req, res, req.body);
    res.json(ok({ user }));
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    await auth.refresh(req, res);
    res.json(accepted('Session refreshed'));
  }),
);

authRouter.post(
  '/logout',
  // Optional auth: logging out with an expired access token must still clear cookies.
  (req, res, next) => authenticate(req, res, () => next()),
  asyncHandler(async (req, res) => {
    await auth.logout(req, res);
    res.json(accepted('Logged out'));
  }),
);

authRouter.post(
  '/forgot-password',
  limiters.forgotPassword(),
  validate({ body: schemas.emailBody }),
  asyncHandler(async (req, res) => {
    await auth.forgotPassword(req, req.body.email);
    res.status(202).json(accepted('If an account exists for that email, a reset link has been sent.'));
  }),
);

authRouter.post(
  '/reset-password',
  limiters.resetPassword(),
  validate({ body: schemas.resetPasswordBody }),
  asyncHandler(async (req, res) => {
    await auth.resetPassword(req, req.body.token, req.body.password);
    res.json(accepted('Password updated. Please log in with your new password.'));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: schemas.changePasswordBody }),
  asyncHandler(async (req, res) => {
    const { userId, familyId } = req.auth!;
    await auth.changePassword(req, userId, familyId, req.body);
    res.json(accepted('Password changed. Other devices have been signed out.'));
  }),
);

authRouter.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(ok({ sessions: await auth.sessions(req.auth!.userId, req.auth!.familyId) }));
  }),
);

authRouter.delete(
  '/sessions/:id',
  authenticate,
  validate({ params: schemas.sessionIdParams }),
  asyncHandler(async (req, res) => {
    await auth.revokeSession(req, req.auth!.userId, req.params.id as string);
    res.json(accepted('Session revoked'));
  }),
);
