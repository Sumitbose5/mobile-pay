import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { closeDb, db } from './client.js';
import { notificationPreferences, systemSettings, users, wallets } from './schema/index.js';

/** Default platform limits, in paise. Editable later from the admin panel. */
const DEFAULT_SETTINGS: Record<string, unknown> = {
  'limits.min_transfer': 100, // Rs 1
  'limits.max_transfer': 5_000_000, // Rs 50,000
  'limits.daily_send': 10_000_000, // Rs 1,00,000
  'limits.max_wallet_balance': 20_000_000, // Rs 2,00,000
  'limits.add_money_min': 1_000, // Rs 10
  'limits.add_money_max': 5_000_000, // Rs 50,000
  'payment_request.expiry_days': 7,
  'idempotency.ttl_hours': 24,
  'wallet.allow_credit_to_frozen': false,
};

async function seed() {
  // 1. System clearing wallet: counterparty for add-money and withdrawals. Only wallet allowed to go negative.
  const [existingSystem] = await db.select().from(wallets).where(eq(wallets.isSystem, true)).limit(1);
  if (!existingSystem) {
    await db.insert(wallets).values({ isSystem: true, userId: null });
    console.log('Created platform clearing wallet');
  }

  // 2. Settings.
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insert(systemSettings).values({ key, value }).onConflictDoNothing();
  }

  // 3. Admin user (with wallet) and demo users.
  await upsertUser('Admin', env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD, 'ADMIN');
  if (env.NODE_ENV !== 'production') {
    await upsertUser('Sumit Demo', 'sumit@coinhub.local', 'Demo@12345', 'USER');
    await upsertUser('Rahul Demo', 'rahul@coinhub.local', 'Demo@12345', 'USER');
  }
  console.log('Seed complete');
}

async function upsertUser(name: string, email: string, password: string, role: 'USER' | 'ADMIN') {
  const normalized = email.toLowerCase();
  const [found] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized)).limit(1);
  if (found) return;

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        name,
        email: normalized,
        passwordHash,
        role,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('Failed to insert user');
    await tx.insert(wallets).values({ userId: user.id });
    await tx.insert(notificationPreferences).values({ userId: user.id });
  });
  console.log(`Created ${role} ${normalized}`);
}

try {
  await seed();
} finally {
  await closeDb();
}
