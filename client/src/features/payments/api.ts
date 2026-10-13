import { api } from '@/lib/api';

export interface Person {
  id: string;
  name: string;
  email: string;
}

export interface Beneficiary {
  id: string;
  nickname: string | null;
  createdAt: string;
  user: Person;
}

export type RequestStatus = 'PENDING' | 'PAID' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

export interface PaymentRequest {
  id: string;
  /** Integer paise as a string. */
  amount: string;
  note: string | null;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  requester: Person;
  payer: Person;
  transactionId: string | null;
}

export interface BankAccount {
  id: string;
  holderName: string;
  label: string;
  accountLast4: string | null;
  upiIdMasked: string | null;
  ifsc: string | null;
  isVerified: boolean;
}

export interface ReportStatus {
  id: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  rows?: number;
  filename?: string;
}

export const beneficiariesApi = {
  list: () =>
    api
      .get<{ data: { beneficiaries: Beneficiary[] } }>('/beneficiaries')
      .then((r) => r.data.data.beneficiaries),
  add: (body: { email: string; nickname?: string; pin: string }) =>
    api.post('/beneficiaries', body),
  rename: (id: string, nickname: string | null) => api.patch(`/beneficiaries/${id}`, { nickname }),
  remove: (id: string) => api.delete(`/beneficiaries/${id}`),
};

export const requestsApi = {
  list: (box: 'received' | 'sent', cursor?: string, limit = 20) =>
    api
      .get<{ data: { items: PaymentRequest[]; nextCursor: string | null } }>('/payment-requests', {
        params: { box, cursor, limit },
      })
      .then((r) => r.data.data),
  create: (body: { payerEmail: string; amount: bigint; note?: string }) =>
    api.post('/payment-requests', { ...body, amount: body.amount.toString() }),
  /** One Idempotency-Key per payment attempt: a retry of the same click can never pay twice. */
  pay: (id: string, pin: string, idempotencyKey: string) =>
    api.post<{ data: { transaction: { id: string } } }>(
      `/payment-requests/${id}/pay`,
      { pin },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    ),
  reject: (id: string) => api.post(`/payment-requests/${id}/reject`),
  cancel: (id: string) => api.post(`/payment-requests/${id}/cancel`),
};

export const bankAccountsApi = {
  list: () =>
    api
      .get<{ data: { bankAccounts: BankAccount[] } }>('/bank-accounts')
      .then((r) => r.data.data.bankAccounts),
  add: (body: {
    holderName: string;
    upiId?: string;
    accountNumber?: string;
    ifsc?: string;
    pin: string;
  }) => api.post('/bank-accounts', body),
  remove: (id: string) => api.delete(`/bank-accounts/${id}`),
  withdraw: (
    body: { bankAccountId: string; amount: bigint; pin: string },
    idempotencyKey: string,
  ) =>
    api
      .post<{
        data: { transaction: { id: string; status: string; amount: string; destination: string } };
      }>(
        '/wallet/withdraw',
        { ...body, amount: body.amount.toString() },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      )
      .then((r) => r.data.data.transaction),
};

export const reportsApi = {
  request: (from: string, to: string) =>
    api
      .post<{ data: { report: ReportStatus } }>('/transactions/export', { from, to })
      .then((r) => r.data.data.report),
  status: (id: string) =>
    api
      .get<{ data: { report: ReportStatus } }>(`/transactions/export/${id}`)
      .then((r) => r.data.data.report),
  /** Fetched with the session cookie, then handed to the browser as a file download. */
  download: async (id: string, filename: string) => {
    const res = await api.get<Blob>(`/transactions/export/${id}/download`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
