/** Amounts travel as integer paise. Convert only at the display edge, using BigInt, never floats. */
export function formatPaise(paise: bigint | number | string): string {
  const value = BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const grouped = new Intl.NumberFormat('en-IN').format(rupees);
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** "100.50" -> 10050n. Returns null for anything that is not a valid rupee amount. */
export function parseRupeesToPaise(input: string): bigint | null {
  const v = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole = '0', frac = ''] = v.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
}
