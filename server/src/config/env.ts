import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_DIRECT: z.string().min(1).optional(),
  DATABASE_SSL: bool,

  REDIS_URL: z.string().min(1),

  /** Isolates queue keys in Redis (tests use a unique prefix per run). */
  QUEUE_PREFIX: z.string().min(1).max(40).default('coinhub'),
  /** First retry delay for failed emails; doubles each attempt (5 attempts). */
  EMAIL_BACKOFF_MS: z.coerce.number().int().min(10).default(5_000),
  /** How often the outbox dispatcher polls when idle. */
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).default(1_000),
  /** Simulated bank latency before a withdrawal payout is processed. */
  PAYOUT_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  /** Tests deliver mail inline unless this is true. */
  MAIL_VIA_QUEUE: bool,

  /** How long a money transaction may wait for a row lock before failing fast with SERVICE_BUSY. */
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),

  JWT_ACCESS_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  GATEWAY_WEBHOOK_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('MobilePay <no-reply@mobilepay.local>'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@mobilepay.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
