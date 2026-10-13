import { api } from '@/lib/api';

export interface AdminStats {
  generatedAt: string;
  users: { total: number; active: number; activeLast30Days: number; pendingVerification: number };
  wallets: { totalBalance: string; frozen: number };
  today: {
    transactions: number;
    successful: number;
    failed: number;
    inFlight: number;
    failureRatePercent: number;
    addMoneyVolume: string;
    transferVolume: string;
  };
  alerts: { warningsLast24h: number; criticalLast24h: number };
  reconciliation: { ok: boolean; ranAt: string } | null;
}

export interface AdminWallet {
  id: string;
  balance: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  freezeReason: string | null;
  frozenAt: string | null;
  frozenBy: string | null;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'USER' | 'ADMIN';
  status: string;
  emailVerified: boolean;
  hasTransactionPin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  wallet: AdminWallet | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  actor: { id: string; name: string | null; email: string | null } | null;
  target: { id: string; name: string | null; email: string | null } | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminParty {
  walletId: string;
  name: string | null;
  email: string | null;
}

export interface AdminTxn {
  id: string;
  type: 'ADD_MONEY' | 'TRANSFER' | 'WITHDRAWAL' | 'REVERSAL';
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  amount: string;
  sender: AdminParty;
  receiver: AdminParty;
  note: string | null;
  failureCode: string | null;
  failureReason: string | null;
  referenceId: string | null;
  requestId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminTxnDetail extends AdminTxn {
  metadata: Record<string, unknown> | null;
  hasIdempotencyKey: boolean;
  reversedBy: string | null;
  reversalOf: string | null;
  canReverse: boolean;
  ledgerEntries: {
    id: string;
    type: 'CREDIT' | 'DEBIT';
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    wallet: { id: string; name: string | null; email: string | null };
    createdAt: string;
  }[];
  auditTrail: {
    id: string;
    action: string;
    severity: string;
    createdAt: string;
    metadata: Record<string, unknown> | null;
  }[];
}

export interface ReconciliationReport {
  ok: boolean;
  scope: 'full' | 'wallets';
  ranAt: string;
  durationMs: number;
  checks: {
    name: string;
    description: string;
    ok: boolean;
    violationCount: number;
    violations: Record<string, unknown>[];
  }[];
}

export type Page<T> = { items: T[]; nextCursor: string | null };
const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

export const adminApi = {
  stats: () =>
    api.get<{ data: { stats: AdminStats } }>('/admin/stats').then((r) => r.data.data.stats),
  users: (params: Record<string, unknown>, cursor?: string) =>
    api
      .get<{ data: Page<AdminUser> }>('/admin/users', {
        params: { ...clean(params), cursor, limit: 20 },
      })
      .then((r) => r.data.data),
  user: (id: string) =>
    api
      .get<{
        data: {
          user: AdminUser;
          activeSessions: number;
          failedTransactions: number;
          recentTransactions: {
            id: string;
            type: string;
            status: string;
            direction: string;
            amount: string;
            signedAmount: string;
            createdAt: string;
            counterparty: { name: string | null } | null;
          }[];
          recentAudit: { id: string; action: string; severity: string; createdAt: string }[];
        };
      }>(`/admin/users/${id}`)
      .then((r) => r.data.data),
  freeze: (id: string, reason: string) => api.post(`/admin/users/${id}/freeze`, { reason }),
  unfreeze: (id: string) => api.post(`/admin/users/${id}/unfreeze`),
  forceLogout: (id: string) => api.post(`/admin/users/${id}/force-logout`),
  transactions: (params: Record<string, unknown>, cursor?: string) =>
    api
      .get<{ data: Page<AdminTxn> }>('/admin/transactions', {
        params: { ...clean(params), cursor, limit: 20 },
      })
      .then((r) => r.data.data),
  transaction: (id: string) =>
    api
      .get<{ data: { transaction: AdminTxnDetail } }>(`/admin/transactions/${id}`)
      .then((r) => r.data.data.transaction),
  reverse: (id: string, reason: string) =>
    api.post(`/admin/transactions/${id}/reverse`, { reason }),
  audit: (params: Record<string, unknown>, cursor?: string, suspicious = false) =>
    api
      .get<{ data: Page<AuditEntry> }>(suspicious ? '/admin/suspicious' : '/admin/audit-logs', {
        params: { ...clean(params), cursor, limit: 30 },
      })
      .then((r) => r.data.data),
  reconciliation: () =>
    api
      .get<{ data: { report: ReconciliationReport | null } }>('/admin/reconciliation')
      .then((r) => r.data.data.report),
  runReconciliation: () =>
    api
      .post<{ data: { report: ReconciliationReport } }>('/admin/reconciliation/run')
      .then((r) => r.data.data.report),
};
