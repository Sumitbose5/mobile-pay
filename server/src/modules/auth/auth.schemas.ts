import { z } from 'zod';
import { passwordSchema } from '../../lib/password.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(255);

export const registerBody = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(100),
  email,
  password: passwordSchema,
});
export const loginBody = z.object({ email, password: z.string().min(1).max(128) });
export const emailBody = z.object({ email });
export const tokenBody = z.object({ token: z.string().min(20).max(200) });
export const resetPasswordBody = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must be different',
    path: ['newPassword'],
  });
export const sessionIdParams = z.object({ id: z.string().uuid() });
