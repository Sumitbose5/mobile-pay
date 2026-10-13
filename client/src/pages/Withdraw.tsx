import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Field, Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/context';
import { bankAccountsApi } from '@/features/payments/api';
import { walletApi } from '@/features/wallet/api';
import { errorMessage } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/money';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

function AddAccountCard() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'upi' | 'bank'>('upi');
  const [holderName, setHolderName] = useState('');
  const [upiId, setUpiId] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [pin, setPin] = useState('');
  const add = useMutation({
    mutationFn: () =>
      bankAccountsApi.add({
        holderName: holderName.trim(),
        pin,
        ...(kind === 'upi'
          ? { upiId: upiId.trim() }
          : { accountNumber: accountNumber.trim(), ifsc: ifsc.trim() }),
      }),
    onSuccess: () => {
      setHolderName('');
      setUpiId('');
      setAccountNumber('');
      setIfsc('');
      void qc.invalidateQueries({ queryKey: ['bank-accounts'] });
    },
    onSettled: () => setPin(''),
  });
  const ready =
    holderName.trim().length >= 2 &&
    pin.length >= 4 &&
    (kind === 'upi' ? upiId.includes('@') : accountNumber.length >= 9 && ifsc.length === 11);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a payout account</CardTitle>
        <CardDescription>
          We store only a masked version. This is a simulated bank: a holder name containing “fail”
          is rejected, so you can see the refund.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) add.mutate();
          }}
        >
          {add.isError && (
            <div className="sm:col-span-2">
              <Notice tone="error">{errorMessage(add.error)}</Notice>
            </div>
          )}
          <div className="flex gap-2 sm:col-span-2" role="group" aria-label="Account type">
            <Button
              type="button"
              size="sm"
              variant={kind === 'upi' ? 'default' : 'outline'}
              aria-pressed={kind === 'upi'}
              onClick={() => setKind('upi')}
            >
              UPI ID
            </Button>
            <Button
              type="button"
              size="sm"
              variant={kind === 'bank' ? 'default' : 'outline'}
              aria-pressed={kind === 'bank'}
              onClick={() => setKind('bank')}
            >
              Bank account
            </Button>
          </div>
          <Field
            id="holder"
            label="Account holder name"
            value={holderName}
            maxLength={100}
            onChange={(e) => setHolderName(e.target.value)}
          />
          {kind === 'upi' ? (
            <Field
              id="upi"
              label="UPI ID"
              placeholder="name@bank"
              autoComplete="off"
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
            />
          ) : (
            <>
              <Field
                id="acct"
                label="Account number"
                inputMode="numeric"
                autoComplete="off"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))}
              />
              <Field
                id="ifsc"
                label="IFSC"
                maxLength={11}
                autoComplete="off"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase())}
              />
            </>
          )}
          <Field
            id="acct-pin"
            label="Transaction PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
          <div className="flex items-end">
            <Button type="submit" disabled={add.isPending || !ready}>
              {add.isPending ? 'Saving...' : 'Save account'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function Withdraw() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletApi.wallet });
  const accounts = useQuery({ queryKey: ['bank-accounts'], queryFn: bankAccountsApi.list });
  const [accountId, setAccountId] = useState('');
  const [rupees, setRupees] = useState('');
  const [pin, setPin] = useState('');
  const [touched, setTouched] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const remove = useMutation({
    mutationFn: bankAccountsApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bank-accounts'] }),
  });

  const selected = accountId || accounts.data?.[0]?.id || '';
  const paise = parseRupeesToPaise(rupees);
  const balance = wallet.data ? BigInt(wallet.data.balance) : null;
  const problem =
    paise === null
      ? 'Enter an amount like 500 or 500.50'
      : paise < 100n
        ? 'Minimum is ₹1'
        : paise > 5_000_000n
          ? 'Maximum is ₹50,000 per withdrawal'
          : balance !== null && paise > balance
            ? 'Not enough balance'
            : null;

  const submit = useMutation({
    mutationFn: () =>
      bankAccountsApi.withdraw(
        { bankAccountId: selected, amount: paise!, pin },
        idempotencyKey.current,
      ),
    onSuccess: () => {
      idempotencyKey.current = crypto.randomUUID();
      setRupees('');
      setTouched(false);
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
    onSettled: () => setPin(''),
  });

  if (user && !user.hasTransactionPin) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Set a transaction PIN first</CardTitle>
          <CardDescription>You confirm withdrawals with your PIN.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/security">Set up PIN</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Withdraw to bank</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Withdraw</CardTitle>
          <CardDescription>
            {balance !== null
              ? `Available balance ${formatPaise(balance)}`
              : 'Move money from your wallet to your bank.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accounts.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add a payout account below to withdraw.</p>
          ) : (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (!problem && pin.length >= 4 && selected) submit.mutate();
              }}
            >
              {submit.isError && <Notice tone="error">{errorMessage(submit.error)}</Notice>}
              {submit.isSuccess && (
                <Notice tone="success">
                  Withdrawal started: {formatPaise(submit.data.amount)} to {submit.data.destination}
                  . The money is held now and the transfer finishes in a few seconds. If the bank
                  rejects it, the full amount returns to your wallet automatically.{' '}
                  <Link className="font-medium underline" to={`/transactions/${submit.data.id}`}>
                    Track it
                  </Link>
                </Notice>
              )}
              <div className="space-y-1.5">
                <label htmlFor="payout" className="text-sm font-medium">
                  To
                </label>
                <select
                  id="payout"
                  className={selectClass}
                  value={selected}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {accounts.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.holderName} · {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                id="w-amount"
                label="Amount (₹)"
                inputMode="decimal"
                autoComplete="off"
                value={rupees}
                onChange={(e) => setRupees(e.target.value)}
                error={touched ? (problem ?? undefined) : undefined}
              />
              <Field
                id="w-pin"
                label="Transaction PIN"
                type="password"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
              <Button type="submit" className="w-full" disabled={submit.isPending}>
                {submit.isPending
                  ? 'Starting...'
                  : paise !== null && !problem
                    ? `Withdraw ${formatPaise(paise)}`
                    : 'Withdraw'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payout accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {accounts.isError && <Notice tone="error">{errorMessage(accounts.error)}</Notice>}
          {remove.isError && <Notice tone="error">{errorMessage(remove.error)}</Notice>}
          <ul className="divide-y">
            {accounts.data?.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.holderName}</p>
                  <p className="truncate text-xs text-muted-foreground">{a.label}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Remove ${a.label}?`)) remove.mutate(a.id);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <AddAccountCard />
    </div>
  );
}
