import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ExportStatement } from '@/components/common/ExportStatement';
import { Notice } from '@/components/common/forms';
import { TransactionRow } from '@/components/common/transactions';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  transactionsApi,
  type Direction,
  type TransactionFilters,
  type TxnStatus,
} from '@/features/transactions/api';
import { errorMessage } from '@/lib/api';
import { parseRupeesToPaise } from '@/lib/money';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const startOfDay = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

export function Transactions() {
  const [q, setQ] = useState('');
  const [direction, setDirection] = useState<Direction | ''>('');
  const [status, setStatus] = useState<TxnStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const debouncedQ = useDebounced(q);
  const debouncedMin = useDebounced(min);
  const debouncedMax = useDebounced(max);

  const filters = useMemo<TransactionFilters>(() => {
    const lo = parseRupeesToPaise(debouncedMin);
    const hi = parseRupeesToPaise(debouncedMax);
    return {
      q: debouncedQ.trim() || undefined,
      direction: direction || undefined,
      status: status || undefined,
      from: startOfDay(from),
      to: endOfDay(to),
      minAmount: lo !== null ? lo.toString() : undefined,
      maxAmount: hi !== null ? hi.toString() : undefined,
    };
  }, [debouncedQ, direction, status, from, to, debouncedMin, debouncedMax]);

  const query = useInfiniteQuery({
    queryKey: ['transactions', filters],
    queryFn: ({ pageParam }) => transactionsApi.list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const hasFilters = Object.values(filters).some(Boolean) || q || min || max;
  const clear = () => {
    setQ('');
    setDirection('');
    setStatus('');
    setFrom('');
    setTo('');
    setMin('');
    setMax('');
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Transactions</h1>
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              type="search"
              placeholder="Name, email, note or transaction ID"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="direction">Type</Label>
            <select
              id="direction"
              className={selectClass}
              value={direction}
              onChange={(e) => setDirection(e.target.value as Direction | '')}
            >
              <option value="">All</option>
              <option value="SENT">Sent</option>
              <option value="RECEIVED">Received</option>
              <option value="ADDED">Added money</option>
              <option value="WITHDRAWN">Withdrawals</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as TxnStatus | '')}
            >
              <option value="">All</option>
              <option value="SUCCESS">Successful</option>
              <option value="FAILED">Failed</option>
              <option value="PENDING">Pending</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="from">From</Label>
            <Input
              id="from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">To</Label>
            <Input
              id="to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="min">Min amount (₹)</Label>
            <Input
              id="min"
              inputMode="decimal"
              value={min}
              onChange={(e) => setMin(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="max">Max amount (₹)</Label>
            <Input
              id="max"
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
            />
          </div>
          {hasFilters && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {query.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
          {query.isError && <Notice tone="error">{errorMessage(query.error)}</Notice>}
          {query.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {hasFilters
                ? 'No transactions match these filters.'
                : 'No transactions yet. Add money to get started.'}
            </p>
          )}
          <ul className="divide-y" aria-live="polite">
            {items.map((t) => (
              <TransactionRow key={t.id} item={t} />
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
      <ExportStatement />
    </div>
  );
}
