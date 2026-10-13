import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { StatusBadge } from '@/components/common/transactions';
import { SeverityBadge } from '@/components/admin/AuditTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/features/admin/api';
import { errorMessage, toApiError } from '@/lib/api';
import { formatPaise } from '@/lib/money';

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
const who = (p: { name: string | null; email: string | null }) =>
  p.email ? `${p.name} (${p.email})` : (p.name ?? '—');

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium sm:text-right">{children}</dd>
    </div>
  );
}

export function AdminTransactionDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'transaction', id],
    queryFn: () => adminApi.transaction(id),
  });
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const reverse = useMutation({
    mutationFn: () => adminApi.reverse(id, reason.trim()),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (q.isError)
    return (
      <div className="space-y-4">
        <Notice tone="error">{errorMessage(q.error)}</Notice>
        <Button asChild variant="outline">
          <Link to="/admin/transactions">Back</Link>
        </Button>
      </div>
    );
  const t = q.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/admin/transactions">Back to transactions</Link>
      </Button>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold">{t.id}</h1>
        <StatusBadge status={t.status} />
        <span className="ml-auto text-2xl font-semibold tabular-nums">{formatPaise(t.amount)}</span>
      </div>

      {t.status === 'FAILED' && (
        <Notice tone="error">
          Failed: <span className="font-mono">{t.failureCode}</span>
          {t.failureReason ? ` — ${t.failureReason}` : ''}. No ledger entries were written for this
          attempt unless it was a refunded withdrawal.
        </Notice>
      )}

      <Card>
        <CardContent className="pt-4">
          <dl className="divide-y">
            <Row label="Type">{t.type.replace('_', ' ').toLowerCase()}</Row>
            <Row label="From">{who(t.sender)}</Row>
            <Row label="To">{who(t.receiver)}</Row>
            {t.note && <Row label="Note">{t.note}</Row>}
            <Row label="Created">{fmt(t.createdAt)}</Row>
            <Row label="Completed">{fmt(t.completedAt)}</Row>
            {t.referenceId && (
              <Row label="Reference">
                <span className="font-mono">{t.referenceId}</span>
              </Row>
            )}
            {t.requestId && (
              <Row label="Request ID (matches server logs)">
                <span className="font-mono">{t.requestId}</span>
              </Row>
            )}
            <Row label="Idempotency key">{t.hasIdempotencyKey ? 'present' : 'none'}</Row>
            {t.reversalOf && (
              <Row label="Reverses">
                <Link className="font-mono underline" to={`/admin/transactions/${t.reversalOf}`}>
                  {t.reversalOf}
                </Link>
              </Row>
            )}
            {t.reversedBy && (
              <Row label="Reversed by">
                <Link className="font-mono underline" to={`/admin/transactions/${t.reversedBy}`}>
                  {t.reversedBy}
                </Link>
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ledger entries</CardTitle>
        </CardHeader>
        <CardContent>
          {t.ledgerEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No money moved.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Wallet</th>
                    <th className="pr-3 font-medium">Entry</th>
                    <th className="pr-3 text-right font-medium">Amount</th>
                    <th className="pr-3 text-right font-medium">Balance before</th>
                    <th className="text-right font-medium">Balance after</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {t.ledgerEntries.map((e) => (
                    <tr key={e.id}>
                      <td className="py-2 pr-3">
                        {e.wallet.name ?? e.wallet.email ?? e.wallet.id}
                      </td>
                      <td
                        className={`pr-3 font-medium ${e.type === 'CREDIT' ? 'text-success' : ''}`}
                      >
                        {e.type.toLowerCase()}
                      </td>
                      <td className="pr-3 text-right tabular-nums">{formatPaise(e.amount)}</td>
                      <td className="pr-3 text-right tabular-nums text-muted-foreground">
                        {formatPaise(e.balanceBefore)}
                      </td>
                      <td className="text-right tabular-nums">{formatPaise(e.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {(t.canReverse || reverse.isSuccess) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reverse this transfer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {reverse.isSuccess && (
              <Notice tone="success">
                Reversed. The original stays on record and a linked reversal moved the money back.
              </Notice>
            )}
            {reverse.isError && (
              <Notice tone="error">
                {toApiError(reverse.error).code === 'INSUFFICIENT_BALANCE'
                  ? 'The recipient has already spent this money, so it cannot be reversed. It has been flagged for manual handling.'
                  : errorMessage(reverse.error)}
              </Notice>
            )}
            {!open && t.canReverse && (
              <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
                Reverse transfer
              </Button>
            )}
            {open && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim().length >= 5) reverse.mutate();
                }}
              >
                <Label htmlFor="rev-reason">
                  Reason (recorded in the audit log and sent to both users)
                </Label>
                <Input
                  id="rev-reason"
                  value={reason}
                  maxLength={200}
                  autoFocus
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="destructive"
                    size="sm"
                    disabled={reverse.isPending || reason.trim().length < 5}
                  >
                    {reverse.isPending ? 'Reversing...' : `Reverse ${formatPaise(t.amount)}`}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Audit trail</CardTitle>
        </CardHeader>
        <CardContent>
          {t.auditTrail.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No audit entries reference this transaction.
            </p>
          )}
          <ul className="divide-y">
            {t.auditTrail.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex items-center gap-2 font-mono">
                  {a.action}
                  <SeverityBadge severity={a.severity} />
                </span>
                <span className="text-xs text-muted-foreground">{fmt(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
