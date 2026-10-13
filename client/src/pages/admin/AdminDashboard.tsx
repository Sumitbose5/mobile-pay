import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AuditList } from '@/components/admin/AuditTable';
import { Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi } from '@/features/admin/api';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/money';

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'bad' | 'good';
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-2xl tabular-nums ${tone === 'bad' ? 'text-destructive' : tone === 'good' ? 'text-success' : ''}`}
        >
          {value}
        </CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}

export function AdminDashboard() {
  const qc = useQueryClient();
  const stats = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: adminApi.stats,
    refetchInterval: 60_000,
  });
  const suspicious = useQuery({
    queryKey: ['admin', 'suspicious', 'top'],
    queryFn: () => adminApi.audit({}, undefined, true),
  });
  const run = useMutation({
    mutationFn: adminApi.runReconciliation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  const s = stats.data;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Overview</h1>
        {s && (
          <p className="text-xs text-muted-foreground">
            Updated {new Date(s.generatedAt).toLocaleTimeString('en-IN')} · refreshes every minute
          </p>
        )}
      </div>
      {stats.isError && <Notice tone="error">{errorMessage(stats.error)}</Notice>}
      {stats.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}

      {s && (
        <>
          <section
            aria-label="Users and money"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Stat
              label="Total users"
              value={s.users.total.toLocaleString('en-IN')}
              hint={`${s.users.pendingVerification} awaiting verification`}
            />
            <Stat
              label="Active users"
              value={s.users.active.toLocaleString('en-IN')}
              hint={`${s.users.activeLast30Days} signed in within 30 days`}
            />
            <Stat
              label="Total wallet balance"
              value={formatPaise(s.wallets.totalBalance)}
              hint="All user wallets"
            />
            <Stat
              label="Frozen wallets"
              value={String(s.wallets.frozen)}
              tone={s.wallets.frozen > 0 ? 'bad' : undefined}
            />
          </section>

          <section aria-label="Today" className="space-y-3">
            <h2 className="text-lg font-semibold">Today</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Transactions"
                value={String(s.today.transactions)}
                hint={`${s.today.inFlight} in flight`}
              />
              <Stat label="Successful" value={String(s.today.successful)} tone="good" />
              <Stat
                label="Failed"
                value={String(s.today.failed)}
                tone={s.today.failed > 0 ? 'bad' : undefined}
                hint={`${s.today.failureRatePercent}% of finished`}
              />
              <Stat
                label="Money added"
                value={formatPaise(s.today.addMoneyVolume)}
                hint={`${formatPaise(s.today.transferVolume)} transferred`}
              />
            </div>
          </section>

          <section aria-label="Health" className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ledger reconciliation</CardTitle>
                <CardDescription>
                  {s.reconciliation
                    ? `Last run ${new Date(s.reconciliation.ranAt).toLocaleString('en-IN')}`
                    : 'Has not run yet. It runs nightly.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {s.reconciliation && (
                  <Notice tone={s.reconciliation.ok ? 'success' : 'error'}>
                    {s.reconciliation.ok
                      ? 'All invariants hold.'
                      : 'Violations found. Open the report.'}
                  </Notice>
                )}
                {run.isError && <Notice tone="error">{errorMessage(run.error)}</Notice>}
                <div className="flex gap-2">
                  <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
                    {run.isPending ? 'Running...' : 'Run now'}
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to="/admin/reconciliation">View report</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Alerts, last 24 hours</CardTitle>
                <CardDescription>
                  {s.alerts.criticalLast24h} critical · {s.alerts.warningsLast24h} warnings
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link to="/admin/suspicious">Suspicious activity</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href="/api/v1/admin/queues/" target="_blank" rel="noreferrer">
                    Job queues
                  </a>
                </Button>
              </CardContent>
            </Card>
          </section>
        </>
      )}

      <section aria-label="Recent suspicious activity">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent suspicious activity</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link to="/admin/suspicious">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {suspicious.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
            {suspicious.data?.items.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">Nothing flagged.</p>
            )}
            {suspicious.data && <AuditList items={suspicious.data.items.slice(0, 5)} />}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
