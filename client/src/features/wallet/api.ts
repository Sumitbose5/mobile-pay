import { api } from '@/lib/api';

export interface Wallet {
  id: string;
  /** Integer paise as a string (never a float). */
  balance: string;
  currency: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  freezeReason: string | null;
}

export interface PaymentOrder {
  id: string;
  gatewayOrderId: string;
  amount: string;
  status: 'CREATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
  failureReason: string | null;
  expiresAt: string;
}

export interface SentTransaction {
  id: string;
  status: string;
  amount: string;
  receiverName: string;
  note: string | null;
  createdAt: string;
}

export const walletApi = {
  lookupRecipient: (email: string) =>
    api
      .get<{ data: { recipient: { id: string; name: string } } }>('/wallet/recipients/lookup', {
        params: { email },
      })
      .then((r) => r.data.data.recipient),
  /** Same Idempotency-Key = same payment. The server remembers only successes, so retrying after a failure is safe. */
  send: (
    body: { receiverEmail: string; amount: bigint; note?: string; pin: string },
    idempotencyKey: string,
  ) =>
    api
      .post<{ data: { transaction: SentTransaction } }>(
        '/wallet/send',
        { ...body, amount: body.amount.toString() },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      )
      .then((r) => r.data.data.transaction),
  wallet: () => api.get<{ data: { wallet: Wallet } }>('/wallet').then((r) => r.data.data.wallet),
  /** The key must stay the same when the same payment is retried, and change for a new payment. */
  addMoney: (amountPaise: bigint, idempotencyKey: string) =>
    api
      .post<{ data: { order: PaymentOrder } }>(
        '/wallet/add-money',
        { amount: amountPaise.toString() },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      )
      .then((r) => r.data.data.order),
  order: (id: string) =>
    api
      .get<{ data: { order: PaymentOrder } }>(`/payments/orders/${id}`)
      .then((r) => r.data.data.order),
  simulate: (id: string, outcome: 'SUCCESS' | 'FAILED') =>
    api
      .post<{ data: { order: PaymentOrder } }>(`/payments/simulator/${id}/complete`, { outcome })
      .then((r) => r.data.data.order),
};
