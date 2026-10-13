import pg from 'pg';

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL_DIRECT or DATABASE_URL is required');

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
} finally {
  await pool.end();
}
