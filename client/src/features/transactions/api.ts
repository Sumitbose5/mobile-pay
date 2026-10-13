import { api } from '@/lib/api';

export type Direction = 'SENT' | 'RECEIVED' | 'ADDED' | 'WITHDRAWN';
export type TxnStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface TransactionItem {
  id: string;
  type: 'ADD_MONEY' | 'TRANSFER' | 'WITHDRAWAL' | 'REVERSAL';
  direction: Direction;
  status: TxnStatus;
  /** Integer paise as strings. */
  amount: string;
  signedAmount: string;
  counterparty: { name: string | null; email: string | null } | null;
  note: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TransactionDetails extends TransactionItem {
  referenceId: string | null;
  failureCode: string | null;
  sender: { name: string | null; email: string | null };
  receiver: { name: string | null; email: string | null };
  balanceBefore: string | null;
  balanceAfter: string | null;
  reversedBy: string | null;
  reversalOf: string | null;
}

export interface TransactionFilters {
  q?: string;
  direction?: Direction;
  status?: TxnStatus;
  from?: string;
  to?: string;
  minAmount?: string;
  maxAmount?: string;
}

export interface MonthlySummary {
  month: string;
  /** Integer paise as strings. */
  sent: string;
  received: string;
  added: string;
  withdrawn: string;
  count: number;
}

export const transactionsApi = {
  summary: () =>
    api
      .get<{ data: { summary: MonthlySummary } }>('/transactions/summary')
      .then((r) => r.data.data.summary),
  list: (filters: TransactionFilters, cursor?: string, limit = 20) =>
    api
      .get<{ data: { items: TransactionItem[]; nextCursor: string | null } }>('/transactions', {
        params: {
          ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
          limit,
          cursor,
        },
      })
      .then((r) => r.data.data),
  get: (id: string) =>
    api
      .get<{ data: { transaction: TransactionDetails } }>(`/transactions/${id}`)
      .then((r) => r.data.data.transaction),
};
