import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { notificationPreferences, users } from '../../db/schema/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { cacheKeys, cached, invalidate } from '../../lib/cache.js';
import { audit } from '../audit/audit.service.js';
import { toUserDto } from '../auth/auth.service.js';
import { changePin, pinSchema, requestPinReset, resetPin, setPin } from '../security/pin.service.js';
import { limiters } from '../../middleware/rateLimit.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

const ok = <T>(data: T) => ({ success: true, data });

const updateProfileBody = z.object({ name: z.string().trim().min(2).max(100) });
const preferencesBody = z
  .object({
    emailMoneyReceived: z.boolean(),
    emailMoneySent: z.boolean(),
    emailPaymentRequests: z.boolean(),
    emailMarketing: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one preference' });

async function currentUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required');
  return user;
}

usersRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    res.json(ok({ user: await cached(cacheKeys.user(userId), 300, async () => toUserDto(await currentUser(userId))) }));
  }),
);

usersRouter.patch(
  '/me',
  validate({ body: updateProfileBody }),
  asyncHandler(async (req, res) => {
    const [updated] = await db
      .update(users)
      .set({ name: req.body.name, updatedAt: new Date() })
      .where(eq(users.id, req.auth!.userId))
      .returning();
    if (!updated) throw new AppError('UNAUTHORIZED', 'Authentication required');
    await invalidate(cacheKeys.user(req.auth!.userId));
    await audit(req, { action: 'PROFILE_UPDATED' });
    res.json(ok({ user: toUserDto(updated) }));
  }),
);

usersRouter.get(
  '/me/notification-preferences',
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    await db.insert(notificationPreferences).values({ userId }).onConflictDoNothing();
    const [prefs] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    res.json(ok({ preferences: prefs }));
  }),
);

usersRouter.patch(
  '/me/notification-preferences',
  validate({ body: preferencesBody }),
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    await db.insert(notificationPreferences).values({ userId }).onConflictDoNothing();
    const [prefs] = await db
      .update(notificationPreferences)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, userId))
      .returning();
    res.json(ok({ preferences: prefs }));
  }),
);

const setPinBody = z.object({ password: z.string().min(1).max(128), pin: pinSchema });
const changePinBody = z.object({ currentPin: z.string().regex(/^\d{4}$|^\d{6}$/), newPin: pinSchema });

usersRouter.post(
  '/me/pin',
  validate({ body: setPinBody }),
  asyncHandler(async (req, res) => {
    await setPin(req, req.auth!.userId, req.body.password, req.body.pin);
    res.status(201).json(ok({ message: 'Transaction PIN set' }));
  }),
);

usersRouter.put(
  '/me/pin',
  validate({ body: changePinBody }),
  asyncHandler(async (req, res) => {
    await changePin(req, req.auth!.userId, req.body.currentPin, req.body.newPin);
    res.json(ok({ message: 'Transaction PIN changed' }));
  }),
);

usersRouter.post(
  '/me/pin/reset-request',
  limiters.forgotPassword(),
  validate({ body: z.object({ password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    await requestPinReset(req, req.auth!.userId, req.body.password);
    res.status(202).json(ok({ message: 'We emailed you a link to reset your PIN. It is valid for 30 minutes.' }));
  }),
);

usersRouter.post(
  '/me/pin/reset',
  validate({ body: z.object({ token: z.string().min(20).max(200), newPin: pinSchema }) }),
  asyncHandler(async (req, res) => {
    await resetPin(req, req.auth!.userId, req.body.token, req.body.newPin);
    res.json(ok({ message: 'Transaction PIN reset' }));
  }),
);
