import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { StatusBadge } from '@/components/common/transactions';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/features/admin/api';
import { errorMessage } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/money';
import { useDebounced } from '@/lib/useDebounced';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const startOfDay = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

export function AdminTransactions() {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? '';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const dq = useDebounced(q);
  const dmin = useDebounced(min);
  const dmax = useDebounced(max);
  const lo = parseRupeesToPaise(dmin);
  const hi = parseRupeesToPaise(dmax);

  const filters = {
    q: dq.trim(),
    status,
    type,
    userId,
    from: startOfDay(from),
    to: endOfDay(to),
    minAmount: lo?.toString(),
    maxAmount: hi?.toString(),
  };
  const query = useInfiniteQuery({
    queryKey: ['admin', 'transactions', filters],
    queryFn: ({ pageParam }) => adminApi.transactions(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Transactions</h1>
      {userId && (
        <Notice>
          Showing one user's transactions.{' '}
          <Link className="font-medium underline" to="/admin/transactions">
            Show everyone's
          </Link>
        </Notice>
      )}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="t-q">Search</Label>
            <Input
              id="t-q"
              type="search"
              placeholder="Transaction ID, name, email, note or reference"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-status">Status</Label>
            <select
              id="t-status"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All</option>
              <option value="SUCCESS">Successful</option>
              <option value="FAILED">Failed</option>
              <option value="PROCESSING">Processing</option>
              <option value="PENDING">Pending</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-type">Type</Label>
            <select
              id="t-type"
              className={selectClass}
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">All</option>
              <option value="TRANSFER">Transfers</option>
              <option value="ADD_MONEY">Add money</option>
              <option value="WITHDRAWAL">Withdrawals</option>
              <option value="REVERSAL">Reversals</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-from">From</Label>
            <Input
              id="t-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-to">To</Label>
            <Input
              id="t-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-min">Min (₹)</Label>
            <Input
              id="t-min"
              inputMode="decimal"
              value={min}
              onChange={(e) => setMin(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-max">Max (₹)</Label>
            <Input
              id="t-max"
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-2">
          {query.isPending && <p className="py-4 text-sm text-muted-foreground">Loading...</p>}
          {query.isError && <Notice tone="error">{errorMessage(query.error)}</Notice>}
          {query.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No transactions match.</p>
          )}
          <ul className="divide-y" aria-live="polite">
            {items.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/admin/transactions/${t.id}`}
                  className="grid gap-1 rounded-md px-2 py-3 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[1fr_auto]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      <span className="font-mono">{t.id}</span>{' '}
                      <span className="text-muted-foreground">
                        {t.type.replace('_', ' ').toLowerCase()}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.sender.name ?? t.sender.email ?? '—'} →{' '}
                      {t.receiver.name ?? t.receiver.email ?? '—'} ·{' '}
                      {new Date(t.createdAt).toLocaleString('en-IN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                      {t.failureCode ? ` · ${t.failureCode}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 sm:justify-end">
                    <StatusBadge status={t.status} />
                    <span className="text-sm font-medium tabular-nums">
                      {formatPaise(t.amount)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
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
