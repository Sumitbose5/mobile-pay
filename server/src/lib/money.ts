/**
 * Money is always handled as integer paise (bigint). Never use floating point.
 * 100 paise = 1 rupee.
 */
export type Paise = bigint;

const PAISE_PER_RUPEE = 100n;

/** Convert a rupee string like "100.50" to paise (10050n). Rejects more than 2 decimals. */
export function rupeesToPaise(input: string): Paise {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new RangeError(`Invalid rupee amount: "${input}"`);
  const whole = BigInt(match[1] as string);
  const frac = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * PAISE_PER_RUPEE + frac;
}

/** Format paise as a plain rupee string, e.g. 10050n -> "100.50". */
export function paiseToRupees(paise: Paise): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const frac = (abs % PAISE_PER_RUPEE).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function assertPositiveAmount(amount: Paise): void {
  if (amount <= 0n) throw new RangeError('Amount must be greater than zero');
}

/** Indian digit grouping with the rupee sign: 12345678n paise -> "₹1,23,456.78". */
export function formatInr(paise: Paise): string {
  const [whole = '0', frac = '00'] = paiseToRupees(paise < 0n ? -paise : paise).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${paise < 0n ? '-' : ''}₹${grouped}.${frac}`;
}
