import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { bankAccounts } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { verifyPin } from '../security/pin.service.js';

const MAX_ACCOUNTS = 5;

const upi = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{1,30}$/, 'Enter a valid UPI ID like name@bank');
const account = z.string().trim().regex(/^\d{9,18}$/, 'Account number must be 9 to 18 digits');
const ifsc = z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code');

export const addBankAccountBody = z
  .object({
    holderName: z.string().trim().min(2).max(100),
    upiId: upi.optional(),
    accountNumber: account.optional(),
    ifsc: ifsc.optional(),
    pin: z.string().regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits'),
  })
  .refine((v) => Boolean(v.upiId) !== Boolean(v.accountNumber), { message: 'Provide either a UPI ID or a bank account number', path: ['upiId'] })
  .refine((v) => !v.accountNumber || Boolean(v.ifsc), { message: 'IFSC is required with a bank account number', path: ['ifsc'] });

/** "ab***@okbank": enough to recognise it, never enough to use it. */
const maskUpi = (id: string) => {
  const [name = '', handle = ''] = id.split('@');
  return `${name.slice(0, 2)}***@${handle}`;
};

export const toDto = (a: typeof bankAccounts.$inferSelect) => ({
  id: a.id,
  holderName: a.holderName,
  label: a.upiIdMasked ?? `Bank account ••${a.accountLast4} (${a.ifsc})`,
  accountLast4: a.accountLast4,
  upiIdMasked: a.upiIdMasked,
  ifsc: a.ifsc,
  isVerified: a.isVerified,
  createdAt: a.createdAt,
});

export const destinationLabel = (a: Pick<typeof bankAccounts.$inferSelect, 'upiIdMasked' | 'accountLast4' | 'ifsc'>) =>
  a.upiIdMasked ?? `bank account ••${a.accountLast4}`;

export async function listBankAccounts(userId: string) {
  const rows = await db.select().from(bankAccounts).where(and(eq(bankAccounts.userId, userId), isNull(bankAccounts.deletedAt))).orderBy(desc(bankAccounts.createdAt));
  return rows.map(toDto);
}

/** Only masked identifiers are ever stored: the full account number and UPI ID are discarded after this call. */
export async function addBankAccount(req: Request, userId: string, input: z.infer<typeof addBankAccountBody>) {
  await verifyPin(req, userId, input.pin);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(bankAccounts).where(and(eq(bankAccounts.userId, userId), isNull(bankAccounts.deletedAt)));
  if (n >= MAX_ACCOUNTS) throw new AppError('LIMIT_EXCEEDED', `You can save up to ${MAX_ACCOUNTS} payout accounts`);
  const [created] = await db
    .insert(bankAccounts)
    .values({
      userId,
      holderName: input.holderName,
      accountLast4: input.accountNumber ? input.accountNumber.slice(-4) : null,
      upiIdMasked: input.upiId ? maskUpi(input.upiId) : null,
      ifsc: input.accountNumber ? (input.ifsc ?? null) : null,
      isVerified: true, // simulated penny-drop verification
    })
    .returning();
  await audit(req, { action: 'BANK_ACCOUNT_ADDED', userId, entityType: 'bank_account', entityId: created!.id });
  return toDto(created!);
}

export async function removeBankAccount(req: Request, userId: string, id: string) {
  const removed = await db.update(bankAccounts).set({ deletedAt: new Date() }).where(and(eq(bankAccounts.id, id), eq(bankAccounts.userId, userId), isNull(bankAccounts.deletedAt))).returning({ id: bankAccounts.id });
  if (removed.length === 0) throw new AppError('RESOURCE_NOT_FOUND', 'Payout account not found');
  await audit(req, { action: 'BANK_ACCOUNT_REMOVED', userId, entityType: 'bank_account', entityId: id });
}

export async function getOwnedAccount(userId: string, id: string) {
  const [a] = await db.select().from(bankAccounts).where(and(eq(bankAccounts.id, id), eq(bankAccounts.userId, userId), isNull(bankAccounts.deletedAt)));
  if (!a) throw new AppError('RESOURCE_NOT_FOUND', 'Payout account not found');
  return a;
}
