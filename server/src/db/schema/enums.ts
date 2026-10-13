import { pgEnum } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['USER', 'ADMIN']);
export const userStatus = pgEnum('user_status', [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'DELETED',
]);
export const walletStatus = pgEnum('wallet_status', ['ACTIVE', 'FROZEN', 'CLOSED']);
export const transactionType = pgEnum('transaction_type', [
  'ADD_MONEY',
  'TRANSFER',
  'WITHDRAWAL',
  'REVERSAL',
]);
export const transactionStatus = pgEnum('transaction_status', [
  'PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
]);
export const ledgerEntryType = pgEnum('ledger_entry_type', ['CREDIT', 'DEBIT']);
export const paymentRequestStatus = pgEnum('payment_request_status', [
  'PENDING',
  'PAID',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
]);
export const paymentOrderStatus = pgEnum('payment_order_status', [
  'CREATED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
]);
export const idempotencyStatus = pgEnum('idempotency_status', ['IN_PROGRESS', 'COMPLETED']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'PROCESSED', 'FAILED']);
export const auditSeverity = pgEnum('audit_severity', ['INFO', 'WARN', 'CRITICAL']);
export const notificationType = pgEnum('notification_type', [
  'MONEY_RECEIVED',
  'MONEY_SENT',
  'PAYMENT_FAILED',
  'REQUEST_RECEIVED',
  'REQUEST_PAID',
  'REQUEST_REJECTED',
  'REQUEST_EXPIRED',
  'WITHDRAWAL_UPDATE',
  'SECURITY',
  'ACCOUNT_STATUS',
  'REPORT_READY',
  'SYSTEM',
]);
