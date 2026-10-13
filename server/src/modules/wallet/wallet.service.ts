import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { wallets } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

export function toWalletDto(w: typeof wallets.$inferSelect) {
  return {
    id: w.id,
    balance: w.balance,
    currency: w.currency,
    status: w.status,
    freezeReason: w.status === 'FROZEN' ? w.freezeReason : null,
    createdAt: w.createdAt,
  };
}

export async function getWalletForUser(userId: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!w) throw new AppError('RESOURCE_NOT_FOUND', 'Wallet not found. Verify your email to activate your wallet.');
  return w;
}
