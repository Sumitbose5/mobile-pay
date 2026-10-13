import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { AmountText, StatusBadge } from '@/components/common/transactions';
import { SeverityBadge } from '@/components/admin/AuditTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/features/admin/api';
import type { TxnStatus } from '@/features/transactions/api';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/money';

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

export function AdminUserDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => adminApi.user(id) });
  const [reason, setReason] = useState('');
  const [freezing, setFreezing] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'user', id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  };
  const freeze = useMutation({
    mutationFn: () => adminApi.freeze(id, reason.trim()),
    onSuccess: () => {
      setFreezing(false);
      setReason('');
      refresh();
    },
  });
  const unfreeze = useMutation({ mutationFn: () => adminApi.unfreeze(id), onSuccess: refresh });
  const logout = useMutation({ mutationFn: () => adminApi.forceLogout(id), onSuccess: refresh });

  if (detail.isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (detail.isError)
    return (
      <div className="space-y-4">
        <Notice tone="error">{errorMessage(detail.error)}</Notice>
        <Button asChild variant="outline">
          <Link to="/admin/users">Back to users</Link>
        </Button>
      </div>
    );

  const { user, activeSessions, failedTransactions, recentTransactions, recentAudit } = detail.data;
  const w = user.wallet;
  const mutationError = freeze.error ?? unfreeze.error ?? logout.error;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/admin/users">Back to users</Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold">{user.name}</h1>
        <p className="text-sm text-muted-foreground">{user.email}</p>
      </div>
      {mutationError && <Notice tone="error">{errorMessage(mutationError)}</Notice>}
      {logout.isSuccess && <Notice tone="success">Signed out of all devices.</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {[
                ['Role', user.role],
                ['Status', user.status.replace(/_/g, ' ').toLowerCase()],
                ['Email verified', user.emailVerified ? 'yes' : 'no'],
                ['Transaction PIN', user.hasTransactionPin ? 'set' : 'not set'],
                ['Joined', fmt(user.createdAt)],
                ['Last sign-in', fmt(user.lastLoginAt)],
                ['Active sessions', String(activeSessions)],
                ['Failed payments', String(failedTransactions)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between py-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-medium capitalize">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={logout.isPending || activeSessions === 0}
                onClick={() => logout.mutate()}
              >
                Sign out everywhere
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Wallet</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {w ? formatPaise(w.balance) : 'No wallet'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {w?.status === 'FROZEN' && (
              <Notice tone="error">
                Frozen {fmt(w.frozenAt)}. Reason: {w.freezeReason}
              </Notice>
            )}
            {w && w.status === 'ACTIVE' && !freezing && user.role !== 'ADMIN' && (
              <Button variant="destructive" size="sm" onClick={() => setFreezing(true)}>
                Freeze wallet
              </Button>
            )}
            {w && w.status === 'ACTIVE' && user.role === 'ADMIN' && (
              <p className="text-sm text-muted-foreground">
                Administrator accounts cannot be frozen.
              </p>
            )}
            {freezing && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim().length >= 5) freeze.mutate();
                }}
              >
                <Label htmlFor="reason">Reason (the user is shown this)</Label>
                <Input
                  id="reason"
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
                    disabled={freeze.isPending || reason.trim().length < 5}
                  >
                    {freeze.isPending ? 'Freezing...' : 'Confirm freeze'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setFreezing(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {w?.status === 'FROZEN' && (
              <Button size="sm" disabled={unfreeze.isPending} onClick={() => unfreeze.mutate()}>
                Unfreeze wallet
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTransactions.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">None yet.</p>
          )}
          <ul className="divide-y">
            {recentTransactions.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/admin/transactions/${t.id}`}
                  className="flex items-center justify-between gap-3 py-3 hover:bg-secondary"
                >
                  <span className="min-w-0 text-sm">
                    <span className="font-mono">{t.id}</span>
                    <span className="ml-2 text-muted-foreground">
                      {t.type.replace('_', ' ').toLowerCase()}
                      {t.counterparty?.name ? ` · ${t.counterparty.name}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={t.status as TxnStatus} />
                    <AmountText
                      item={{
                        signedAmount: t.signedAmount,
                        amount: t.amount,
                        status: t.status as TxnStatus,
                      }}
                      className="text-sm"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="pt-2">
            <Button asChild variant="ghost" size="sm">
              <Link to={`/admin/transactions?userId=${user.id}`}>
                All transactions for this user
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent audit events</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/admin/audit-logs?userId=${user.id}`}>Full audit trail</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {recentAudit.map((a) => (
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
