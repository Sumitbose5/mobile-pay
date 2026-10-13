import type { TransactionItem } from './api';

export function directionLabel(t: Pick<TransactionItem, 'direction' | 'counterparty'>): string {
  const who = t.counterparty?.name ?? t.counterparty?.email ?? 'someone';
  switch (t.direction) {
    case 'SENT':
      return `Sent to ${who}`;
    case 'RECEIVED':
      return `Received from ${who}`;
    case 'ADDED':
      return 'Added money';
    case 'WITHDRAWN':
      return 'Withdrawal to bank';
  }
}
