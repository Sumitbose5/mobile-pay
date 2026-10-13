import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { db } from '../../db/client.js';
import { pgErrorCode } from '../../db/transaction.js';
import { beneficiaries, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { verifyPin } from '../security/pin.service.js';
import { findRecipient } from '../wallet/transfer.service.js';

const MAX_BENEFICIARIES = 50;

const row = {
  id: beneficiaries.id,
  nickname: beneficiaries.nickname,
  createdAt: beneficiaries.createdAt,
  userId: users.id,
  name: users.name,
  email: users.email,
};
const dto = (r: { id: string; nickname: string | null; createdAt: Date; userId: string; name: string; email: string }) => ({
  id: r.id,
  nickname: r.nickname,
  createdAt: r.createdAt,
  user: { id: r.userId, name: r.name, email: r.email },
});

const mine = (ownerId: string, id: string) =>
  and(eq(beneficiaries.id, id), eq(beneficiaries.ownerId, ownerId), isNull(beneficiaries.deletedAt));

export async function listBeneficiaries(ownerId: string) {
  const rows = await db
    .select(row)
    .from(beneficiaries)
    .innerJoin(users, eq(users.id, beneficiaries.beneficiaryUserId))
    .where(and(eq(beneficiaries.ownerId, ownerId), isNull(beneficiaries.deletedAt)))
    .orderBy(desc(beneficiaries.createdAt));
  return rows.map(dto);
}

/** Adding a payee is a security-relevant act (it makes future theft easier), so it needs the PIN and is audited. */
export async function addBeneficiary(req: Request, ownerId: string, input: { email: string; nickname?: string | undefined; pin: string }) {
  const target = await findRecipient({ email: input.email });
  if (target.userId === ownerId) throw new AppError('VALIDATION_ERROR', 'You cannot add yourself as a beneficiary');
  await verifyPin(req, ownerId, input.pin);

  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(beneficiaries)
    .where(and(eq(beneficiaries.ownerId, ownerId), isNull(beneficiaries.deletedAt)));
  if (n >= MAX_BENEFICIARIES) throw new AppError('LIMIT_EXCEEDED', `You can save up to ${MAX_BENEFICIARIES} beneficiaries`);

  try {
    const [created] = await db
      .insert(beneficiaries)
      .values({ ownerId, beneficiaryUserId: target.userId, nickname: input.nickname?.trim() || null })
      .returning({ id: beneficiaries.id });
    await audit(req, { action: 'BENEFICIARY_ADDED', userId: ownerId, targetUserId: target.userId, entityType: 'beneficiary', entityId: created!.id });
    const [full] = await db.select(row).from(beneficiaries).innerJoin(users, eq(users.id, beneficiaries.beneficiaryUserId)).where(eq(beneficiaries.id, created!.id));
    return dto(full!);
  } catch (err) {
    // The partial unique index (owner, beneficiary) WHERE not deleted is the real guard; this handles the race.
    if (pgErrorCode(err) === '23505') throw new AppError('ALREADY_EXISTS', 'This person is already in your beneficiaries');
    throw err;
  }
}

export async function renameBeneficiary(ownerId: string, id: string, nickname: string | null) {
  const updated = await db.update(beneficiaries).set({ nickname }).where(mine(ownerId, id)).returning({ id: beneficiaries.id });
  if (updated.length === 0) throw new AppError('RESOURCE_NOT_FOUND', 'Beneficiary not found');
  const [full] = await db.select(row).from(beneficiaries).innerJoin(users, eq(users.id, beneficiaries.beneficiaryUserId)).where(eq(beneficiaries.id, id));
  return dto(full!);
}

/** Soft delete: the row is kept for the audit trail, and the person can be added again later. */
export async function removeBeneficiary(req: Request, ownerId: string, id: string) {
  const removed = await db.update(beneficiaries).set({ deletedAt: new Date() }).where(mine(ownerId, id)).returning({ id: beneficiaries.id, target: beneficiaries.beneficiaryUserId });
  if (removed.length === 0) throw new AppError('RESOURCE_NOT_FOUND', 'Beneficiary not found');
  await audit(req, { action: 'BENEFICIARY_REMOVED', userId: ownerId, targetUserId: removed[0]!.target, entityType: 'beneficiary', entityId: id });
}
