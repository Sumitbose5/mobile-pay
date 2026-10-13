import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi } from '@/features/admin/api';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export function AdminReconciliation() {
  const qc = useQueryClient();
  const latest = useQuery({
    queryKey: ['admin', 'reconciliation'],
    queryFn: adminApi.reconciliation,
  });
  const run = useMutation({
    mutationFn: adminApi.runReconciliation,
    onSuccess: (r) => {
      qc.setQueryData(['admin', 'reconciliation'], r);
      void qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
  const report = latest.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Ledger reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Proves the books balance: balances match the ledger, entries chain without gaps, debits
            equal credits, and money is only moved, never created.
          </p>
        </div>
        <Button disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Running...' : 'Run now'}
        </Button>
      </div>
      {run.isError && <Notice tone="error">{errorMessage(run.error)}</Notice>}
      {latest.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
      {latest.isSuccess && !report && (
        <Notice>No report yet. It runs nightly, or run it now.</Notice>
      )}
      {report && (
        <>
          <Notice tone={report.ok ? 'success' : 'error'}>
            {report.ok
              ? 'All invariants hold.'
              : `${report.checks.filter((c) => !c.ok).length} check(s) failed.`}{' '}
            Ran {new Date(report.ranAt).toLocaleString('en-IN')} in {report.durationMs} ms.
          </Notice>
          <div className="space-y-3">
            {report.checks.map((c) => (
              <Card key={c.name}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-semibold',
                        c.ok ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {c.ok ? 'PASS' : 'FAIL'}
                    </span>
                    <span className="font-mono">{c.name}</span>
                    {!c.ok && (
                      <span className="text-xs font-normal text-destructive">
                        {c.violationCount} violation(s)
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>{c.description}</CardDescription>
                </CardHeader>
                {!c.ok && (
                  <CardContent>
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                      {JSON.stringify(c.violations, null, 2)}
                    </pre>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
