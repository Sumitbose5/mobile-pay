import { z } from 'zod';

/** Express `json replacer`: BigInt cannot be JSON-encoded, so amounts cross the API as integer strings (ADR 0001). */
export const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/** Request-side money: accepts an integer string or integer number, yields a positive bigint in paise. */
export const paiseSchema = z
  .union([z.string().regex(/^\d{1,15}$/, 'Amount must be a whole number of paise'), z.number().int().safe()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'Amount must be greater than zero');
