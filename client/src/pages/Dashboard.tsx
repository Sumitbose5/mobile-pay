import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { TransactionRow } from '@/components/common/transactions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/context';
import { transactionsApi } from '@/features/transactions/api';
import { walletApi } from '@/features/wallet/api';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/money';

export function Dashboard() {
  const { user } = useAuth();
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletApi.wallet });
  const summary = useQuery({
    queryKey: ['transactions', 'summary'],
    queryFn: transactionsApi.summary,
  });
  const recent = useQuery({
    queryKey: ['transactions', 'recent'],
    queryFn: () => transactionsApi.list({}, undefined, 5),
  });
  if (!user) return null;
  const w = wallet.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Hi, {user.name.split(' ')[0]}</h1>
        <p className="text-muted-foreground">Your wallet at a glance.</p>
      </div>
      {!user.hasTransactionPin && (
        <Notice>
          Set a transaction PIN to add and move money.{' '}
          <Link className="font-medium underline" to="/security">
            Set it up
          </Link>
        </Notice>
      )}
      {w?.status === 'FROZEN' && (
        <Notice tone="error">
          Your wallet is frozen{w.freezeReason ? `: ${w.freezeReason}` : ''}. You can view your
          balance but cannot move money. Please contact support.
        </Notice>
      )}
      <Card>
        <CardHeader>
          <CardDescription>Wallet balance</CardDescription>
          <CardTitle className="text-4xl tabular-nums" aria-live="polite">
            {wallet.isPending ? '—' : w ? formatPaise(w.balance) : 'Unavailable'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {wallet.isError && <Notice tone="error">{errorMessage(wallet.error)}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="accent" disabled={w?.status !== 'ACTIVE'}>
              <Link to="/wallet/add">Add money</Link>
            </Button>
            <Button asChild variant="outline" disabled={w?.status !== 'ACTIVE'}>
              <Link to="/send">Send money</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/requests">Request money</Link>
            </Button>
            <Button asChild variant="outline" disabled={w?.status !== 'ACTIVE'}>
              <Link to="/wallet/withdraw">Withdraw</Link>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Review your{' '}
            <Link className="underline" to="/security">
              sessions and security settings
            </Link>
            .
          </p>
        </CardContent>
      </Card>
      {summary.data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardDescription>Money in this month</CardDescription>
              <CardTitle className="text-2xl tabular-nums text-success">
                {formatPaise(BigInt(summary.data.received) + BigInt(summary.data.added))}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Money out this month</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {formatPaise(BigInt(summary.data.sent) + BigInt(summary.data.withdrawn))}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent activity</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link to="/transactions">View all</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recent.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
          {recent.isError && <Notice tone="error">{errorMessage(recent.error)}</Notice>}
          {recent.data && recent.data.items.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No transactions yet. Add money to get started.
            </p>
          )}
          <ul className="divide-y">
            {recent.data?.items.map((t) => (
              <TransactionRow key={t.id} item={t} />
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent activity</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link to="/transactions">View all</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recent.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
          {recent.isError && <Notice tone="error">{errorMessage(recent.error)}</Notice>}
          {recent.data && recent.data.items.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No transactions yet. Add money to get started.
            </p>
          )}
          <ul className="divide-y">
            {recent.data?.items.map((t) => (
              <TransactionRow key={t.id} item={t} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
