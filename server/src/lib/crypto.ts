import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** URL-safe random token (256 bits). The raw value goes to the user; only its hash is stored. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Signed CSRF token: "<random>.<hmac>". Signature stops an attacker from planting their own cookie value. */
export function createCsrfToken(secret: string): string {
  const nonce = randomToken(16);
  const sig = createHmac('sha256', secret).update(nonce).digest('base64url');
  return `${nonce}.${sig}`;
}

export function verifyCsrfSignature(token: string, secret: string): boolean {
  const [nonce, sig] = token.split('.');
  if (!nonce || !sig) return false;
  const expected = createHmac('sha256', secret).update(nonce).digest('base64url');
  return safeEqual(sig, expected);
}
