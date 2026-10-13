import { z } from 'zod';

export const emailField = z.string().trim().toLowerCase().email('Enter a valid email');

// Mirrors the server policy so users get instant feedback; the server remains the authority.
export const passwordField = z
  .string()
  .min(8, 'At least 8 characters')
  .regex(/[a-z]/, 'Add a lowercase letter')
  .regex(/[A-Z]/, 'Add an uppercase letter')
  .regex(/\d/, 'Add a number');
