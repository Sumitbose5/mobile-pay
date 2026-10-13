export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  EMAIL_NOT_VERIFIED: 403,
  RESOURCE_NOT_FOUND: 404,
  REQUEST_IN_PROGRESS: 409,
  ALREADY_EXISTS: 409,
  REQUEST_NOT_PENDING: 409,
  DUPLICATE_TRANSACTION: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  INSUFFICIENT_BALANCE: 422,
  WALLET_FROZEN: 423,
  RECEIVER_WALLET_FROZEN: 423,
  LIMIT_EXCEEDED: 422,
  INVALID_PIN: 401,
  PIN_LOCKED: 423,
  PIN_NOT_SET: 412,
  TRANSACTION_FAILED: 500,
  RATE_LIMITED: 429,
  SERVICE_BUSY: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = details;
  }
}
