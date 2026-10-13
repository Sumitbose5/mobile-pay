import pg from 'pg';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await pool.query(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm;',
  );
  console.log('Database reset. Run `npm run db:migrate` and `npm run db:seed`.');
} finally {
  await pool.end();
}
