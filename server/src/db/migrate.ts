import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

// Migrations use the DIRECT (non-pooled) connection: DDL and advisory locks are unsafe through a pooler.
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL_DIRECT or DATABASE_URL is required');

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

try {
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });
  console.log('Migrations applied');
} finally {
  await pool.end();
}

