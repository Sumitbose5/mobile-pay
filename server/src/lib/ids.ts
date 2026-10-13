import { randomBytes } from 'node:crypto';

// Crockford-style base32 without ambiguous characters.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return out;
}

/** Public, non-sequential transaction id, e.g. TXN_8A92K3M7QX4P */
export function newTransactionPublicId(): string {
  return `TXN_${randomString(12)}`;
}
