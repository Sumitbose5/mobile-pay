import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { listNotifications, listQuery, markAllRead, markRead, unreadCount } from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);
const ok = <T>(data: T) => ({ success: true, data });

notificationsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    res.json(ok(await listNotifications(req.auth!.userId, listQuery.parse(req.query))));
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json(ok({ count: await unreadCount(req.auth!.userId) }));
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    res.json(ok({ updated: await markAllRead(req.auth!.userId) }));
  }),
);

notificationsRouter.patch(
  '/:id/read',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    await markRead(req.auth!.userId, req.params.id as string);
    res.json(ok({ message: 'Marked as read' }));
  }),
);
