import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { AmountText, StatusBadge } from '@/components/common/transactions';
import { directionLabel } from '@/features/transactions/labels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { transactionsApi } from '@/features/transactions/api';
import { errorMessage, toApiError } from '@/lib/api';
import { formatPaise } from '@/lib/money';

const TYPE_LABEL = {
  ADD_MONEY: 'Add money',
  TRANSFER: 'Transfer',
  WITHDRAWAL: 'Withdrawal',
  REVERSAL: 'Reversal',
} as const;
const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const party = (p: { name: string | null; email: string | null }) =>
  p.email ? `${p.name} (${p.email})` : (p.name ?? '—');

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium sm:text-right">{children}</dd>
    </div>
  );
}

export function TransactionDetail() {
  const { id = '' } = useParams();
  const [copied, setCopied] = useState(false);
  const {
    data: t,
    isPending,
    error,
  } = useQuery({ queryKey: ['transaction', id], queryFn: () => transactionsApi.get(id) });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error || !t) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <Notice tone="error">
          {toApiError(error).code === 'RESOURCE_NOT_FOUND'
            ? 'We could not find that transaction.'
            : errorMessage(error)}
        </Notice>
        <Button asChild variant="outline">
          <Link to="/transactions">Back to transactions</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/transactions">Back to transactions</Link>
      </Button>
      <Card>
        <CardHeader className="items-center text-center">
          <p className="text-sm text-muted-foreground">{directionLabel(t)}</p>
          <AmountText item={t} className="text-4xl" />
          <StatusBadge status={t.status} />
        </CardHeader>
        <CardContent>
          {t.status === 'FAILED' && (
            <div className="mb-3">
              <Notice tone="error">
                This payment did not go through{t.failureReason ? `: ${t.failureReason}` : ''}. No
                money was taken.
              </Notice>
            </div>
          )}
          <dl className="divide-y">
            <Row label="Transaction ID">
              <span className="font-mono">{t.id}</span>{' '}
              <button
                type="button"
                className="ml-1 text-xs font-normal underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(t.id);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </Row>
            <Row label="Type">{TYPE_LABEL[t.type]}</Row>
            <Row label="From">{party(t.sender)}</Row>
            <Row label="To">{party(t.receiver)}</Row>
            {t.note && <Row label="Note">{t.note}</Row>}
            <Row label="Created">{fmt(t.createdAt)}</Row>
            <Row label="Completed">{fmt(t.completedAt)}</Row>
            {t.referenceId && (
              <Row label="Reference ID">
                <span className="font-mono">{t.referenceId}</span>
              </Row>
            )}
            {t.balanceBefore !== null && t.balanceAfter !== null && (
              <Row label="Your balance">
                <span className="tabular-nums">
                  {formatPaise(t.balanceBefore)} → {formatPaise(t.balanceAfter)}
                </span>
              </Row>
            )}
            {t.reversalOf && (
              <Row label="Reverses">
                <Link className="underline" to={`/transactions/${t.reversalOf}`}>
                  {t.reversalOf}
                </Link>
              </Row>
            )}
            {t.reversedBy && (
              <Row label="Reversed by">
                <Link className="underline" to={`/transactions/${t.reversedBy}`}>
                  {t.reversedBy}
                </Link>
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
