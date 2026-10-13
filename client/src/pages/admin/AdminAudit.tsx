import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AuditList } from '@/components/admin/AuditTable';
import { Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/features/admin/api';
import { errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/useDebounced';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const startOfDay = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

/** The full audit log, or (with `suspicious`) only the events an admin should look at. */
export function AdminAudit({ suspicious = false }: { suspicious?: boolean }) {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? '';
  const [action, setAction] = useState('');
  const [severity, setSeverity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const daction = useDebounced(action.trim().toUpperCase());
  const filters = { userId, action: daction, severity, from: startOfDay(from), to: endOfDay(to) };

  const query = useInfiniteQuery({
    queryKey: ['admin', suspicious ? 'suspicious' : 'audit', filters],
    queryFn: ({ pageParam }) => adminApi.audit(filters, pageParam, suspicious),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {suspicious ? 'Suspicious activity' : 'Audit log'}
        </h1>
        {suspicious && (
          <p className="text-sm text-muted-foreground">
            Flagged transfers (velocity, large amounts, new payees), PIN lockouts, token reuse,
            blocked reversals and failed reconciliations. Flags never block a payment; they exist
            for review.
          </p>
        )}
      </div>
      {userId && <Notice>Filtered to one user's events.</Notice>}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="a-action">Action</Label>
            <Input
              id="a-action"
              placeholder="e.g. ACCOUNT_FROZEN"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-sev">Severity</Label>
            <select
              id="a-sev"
              className={selectClass}
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option value="">All</option>
              <option value="INFO">Info</option>
              <option value="WARN">Warning</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-from">From</Label>
            <Input
              id="a-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-to">To</Label>
            <Input
              id="a-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-2">
          {query.isPending && <p className="py-4 text-sm text-muted-foreground">Loading...</p>}
          {query.isError && <Notice tone="error">{errorMessage(query.error)}</Notice>}
          {query.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {suspicious ? 'Nothing flagged.' : 'No events match.'}
            </p>
          )}
          <AuditList items={items} />
          {query.hasNextPage && (
            <div className="pt-4 text-center">
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
