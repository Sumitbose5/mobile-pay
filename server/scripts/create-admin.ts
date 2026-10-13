/*
 * Create or promote an administrator. There is deliberately no public way to become one.
 * Usage: npm run admin:create -- <email> "<Full Name>" <password>
 */
import { eq, sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.js';
import { notificationPreferences, users, wallets } from '../src/db/schema/index.js';
import { hashPassword, passwordSchema } from '../src/lib/password.js';

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Usage: npm run admin:create -- <email> "<Full Name>" <password>');
  process.exit(2);
}

try {
  const strong = passwordSchema.safeParse(password);
  if (!strong.success) throw new Error(strong.error.issues.map((i) => i.message).join('; '));
  const passwordHash = await hashPassword(password);
  const wanted = email.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, wanted));
  const fields = { role: 'ADMIN' as const, status: 'ACTIVE' as const, passwordHash, emailVerifiedAt: new Date(), updatedAt: new Date() };
  const [row] = existing
    ? await db.update(users).set({ ...fields, name }).where(eq(users.id, existing.id)).returning({ id: users.id })
    : await db.insert(users).values({ name, email: wanted, ...fields }).returning({ id: users.id });
  await db.insert(wallets).values({ userId: row!.id }).onConflictDoNothing();
  await db.insert(notificationPreferences).values({ userId: row!.id }).onConflictDoNothing();
  const [check] = await db.select({ role: users.role }).from(users).where(eq(users.id, row!.id));
  console.log(`${email} is now an ${check?.role}`);
} catch (err) {
  console.error('Could not create the administrator:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
