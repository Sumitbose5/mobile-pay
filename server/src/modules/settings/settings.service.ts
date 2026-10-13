import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { systemSettings } from '../../db/schema/index.js';

/** Platform limits in paise. Defaults apply when a row is missing, so a fresh database still works. */
const DEFAULTS = {
  'limits.min_transfer': 100,
  'limits.max_transfer': 5_000_000,
  'limits.daily_send': 10_000_000,
  'limits.max_wallet_balance': 20_000_000,
  'limits.add_money_min': 1_000,
  'limits.add_money_max': 5_000_000,
  'payment_request.expiry_days': 7,
  'idempotency.ttl_hours': 24,
  'wallet.allow_credit_to_frozen': false,
  // Fraud rules only FLAG for admin review; they never block a payment.
  'fraud.velocity_count': 10,
  'fraud.velocity_window_seconds': 60,
  'fraud.large_amount': 1_000_000,
  'fraud.new_payee_amount': 500_000,
} as const;

type Key = keyof typeof DEFAULTS;
const CACHE_MS = 30_000;
let cache: { at: number; values: Record<string, unknown> } | undefined;

async function load(): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  const rows = await db.select().from(systemSettings).where(inArray(systemSettings.key, Object.keys(DEFAULTS)));
  const values: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) values[r.key] = r.value;
  cache = { at: Date.now(), values };
  return values;
}

export const clearSettingsCache = (): void => {
  cache = undefined;
};

export async function getNumber(key: Key): Promise<bigint> {
  const v = (await load())[key];
  return BigInt(Number(v));
}

export async function getBool(key: Key): Promise<boolean> {
  return (await load())[key] === true;
}
