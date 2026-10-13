import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/features/admin/api';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/money';
import { useDebounced } from '@/lib/useDebounced';
import { cn } from '@/lib/utils';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

export function AdminUsers() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [wallet, setWallet] = useState('');
  const [role, setRole] = useState('');
  const dq = useDebounced(q);

  const query = useInfiniteQuery({
    queryKey: ['admin', 'users', dq, status, wallet, role],
    queryFn: ({ pageParam }) => adminApi.users({ q: dq.trim(), status, wallet, role }, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="u-q">Search name or email</Label>
            <Input id="u-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-status">Account</Label>
            <select
              id="u-status"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING_VERIFICATION">Awaiting verification</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-wallet">Wallet</Label>
            <select
              id="u-wallet"
              className={selectClass}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="FROZEN">Frozen</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-role">Role</Label>
            <select
              id="u-role"
              className={selectClass}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="">All</option>
              <option value="USER">Users</option>
              <option value="ADMIN">Admins</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-2">
          {query.isPending && <p className="py-4 text-sm text-muted-foreground">Loading...</p>}
          {query.isError && <Notice tone="error">{errorMessage(query.error)}</Notice>}
          {query.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No users match.</p>
          )}
          <ul className="divide-y" aria-live="polite">
            {items.map((u) => (
              <li key={u.id}>
                <Link
                  to={`/admin/users/${u.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md px-2 py-3 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {u.name}
                      {u.role === 'ADMIN' && (
                        <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                          admin
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {u.email} · joined{' '}
                      {new Date(u.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-sm">
                    {u.status !== 'ACTIVE' && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize text-muted-foreground">
                        {u.status.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    )}
                    {u.wallet?.status === 'FROZEN' && (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                        frozen
                      </span>
                    )}
                    <span className={cn('tabular-nums', !u.wallet && 'text-muted-foreground')}>
                      {u.wallet ? formatPaise(u.wallet.balance) : 'no wallet'}
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
