import { z } from 'zod';
import { AppError } from './errors.js';

/** Opaque keyset cursor over (created_at, id). The timestamp travels as text to keep microsecond precision. */
export const encodeCursor = (ts: string, id: string): string => Buffer.from(JSON.stringify([ts, id])).toString('base64url');

export function decodeCursor(cursor: string): [string, string] {
  try {
    const [ts, id] = z.tuple([z.string(), z.string().uuid()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return [ts, id];
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
  }
}
