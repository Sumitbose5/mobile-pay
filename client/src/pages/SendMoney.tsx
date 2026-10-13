import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Field, Notice } from '@/components/common/forms';
import { PaymentLoader } from '@/components/common/PaymentLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/context';
import { beneficiariesApi } from '@/features/payments/api';
import { walletApi, type SentTransaction } from '@/features/wallet/api';
import { errorMessage, toApiError } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/money';

type Step = 'details' | 'confirm' | 'done';

export function SendMoney() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletApi.wallet });
  const [step, setStep] = useState<Step>('details');
  const [params] = useSearchParams();
  const saved = useQuery({ queryKey: ['beneficiaries'], queryFn: beneficiariesApi.list });
  const [email, setEmail] = useState(params.get('to') ?? '');
  const [rupees, setRupees] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [touched, setTouched] = useState(false);
  const [sent, setSent] = useState<SentTransaction | null>(null);
  // One key per payment: a double click or network retry reuses it; a new payment gets a fresh one.
  const idempotencyKey = useRef(crypto.randomUUID());

  const paise = parseRupeesToPaise(rupees);
  const balance = wallet.data ? BigInt(wallet.data.balance) : null;
  const emailProblem = !/^\S+@\S+\.\S+$/.test(email.trim())
    ? "Enter the recipient's email"
    : email.trim().toLowerCase() === user?.email
      ? 'You cannot send money to yourself'
      : null;
  const amountProblem =
    paise === null
      ? 'Enter an amount like 250 or 250.50'
      : paise < 100n
        ? 'Minimum is ₹1'
        : paise > 5_000_000n
          ? 'Maximum is ₹50,000 per transfer'
          : balance !== null && paise > balance
            ? 'Not enough balance'
            : null;

  const recipient = useMutation({
    mutationFn: () => walletApi.lookupRecipient(email.trim().toLowerCase()),
    onSuccess: () => setStep('confirm'),
  });
  const send = useMutation({
    mutationFn: () =>
      walletApi.send(
        {
          receiverEmail: email.trim().toLowerCase(),
          amount: paise!,
          note: note.trim() || undefined,
          pin,
        },
        idempotencyKey.current,
      ),
    onSuccess: (txn) => {
      idempotencyKey.current = crypto.randomUUID();
      setSent(txn);
      setStep('done');
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: () => setPin(''),
  });

  if (user && !user.hasTransactionPin) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Set a transaction PIN first</CardTitle>
          <CardDescription>You confirm every payment with your PIN.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/security">Set up PIN</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (step === 'done' && sent) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Sent {formatPaise(sent.amount)}</CardTitle>
          <CardDescription>to {sent.receiverName}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Notice tone="success">Payment successful. Transaction {sent.id}</Notice>
          <div className="flex gap-2">
            <Button asChild>
              <Link to={`/transactions/${sent.id}`}>View details</Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep('details');
                setEmail('');
                setRupees('');
                setNote('');
                setSent(null);
                setTouched(false);
              }}
            >
              Send another
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const code = send.isError ? toApiError(send.error).code : null;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Send money</CardTitle>
        <CardDescription>
          {balance !== null
            ? `Available balance ${formatPaise(balance)}`
            : 'Instant, between CoinHub wallets.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PaymentLoader
          isVisible={send.isPending}
          message={`Sending ${rupees ? `₹${Number(rupees).toLocaleString('en-IN')}` : '...'}`}
        />
        {step === 'details' && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!emailProblem && !amountProblem) recipient.mutate();
            }}
          >
            {recipient.isError && (
              <Notice tone="error">
                {toApiError(recipient.error).code === 'RESOURCE_NOT_FOUND'
                  ? 'No CoinHub user found with that email.'
                  : errorMessage(recipient.error)}
              </Notice>
            )}
            {saved.data && saved.data.length > 0 && (
              <div className="space-y-1.5">
                <label htmlFor="saved" className="text-sm font-medium">
                  Saved beneficiaries
                </label>
                <select
                  id="saved"
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  value={
                    saved.data.find((b) => b.user.email === email.trim().toLowerCase())?.user
                      .email ?? ''
                  }
                  onChange={(e) => e.target.value && setEmail(e.target.value)}
                >
                  <option value="">Choose someone...</option>
                  {saved.data.map((b) => (
                    <option key={b.id} value={b.user.email}>
                      {b.nickname ? `${b.nickname} (${b.user.name})` : b.user.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Field
              id="to"
              label="Recipient email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={touched ? (emailProblem ?? undefined) : undefined}
            />
            <Field
              id="amount"
              label="Amount (₹)"
              inputMode="decimal"
              autoComplete="off"
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              error={touched ? (amountProblem ?? undefined) : undefined}
            />
            <Field
              id="note"
              label="Note (optional)"
              maxLength={255}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" className="w-full" disabled={recipient.isPending}>
              {recipient.isPending ? 'Checking...' : 'Review'}
            </Button>
          </form>
        )}

        {step === 'confirm' && paise !== null && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (pin.length >= 4) send.mutate();
            }}
          >
            <dl className="space-y-2 rounded-md bg-muted p-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">To</dt>
                <dd className="font-medium">
                  {recipient.data?.name}{' '}
                  <span className="font-normal text-muted-foreground">
                    ({email.trim().toLowerCase()})
                  </span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(paise)}</dd>
              </div>
              {note.trim() && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Note</dt>
                  <dd>{note.trim()}</dd>
                </div>
              )}
              {balance !== null && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Balance after</dt>
                  <dd className="tabular-nums">{formatPaise(balance - paise)}</dd>
                </div>
              )}
            </dl>
            {send.isError && (
              <Notice tone="error">
                {code === 'REQUEST_IN_PROGRESS'
                  ? 'This payment is already being processed. Check your transactions before retrying.'
                  : errorMessage(send.error)}
              </Notice>
            )}
            <Field
              id="pin"
              label="Transaction PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={send.isPending}
                onClick={() => {
                  send.reset();
                  setPin('');
                  setStep('details');
                }}
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="accent"
                disabled={send.isPending || pin.length < 4 || code === 'PIN_LOCKED'}
              >
                {send.isPending ? 'Sending...' : `Send ${formatPaise(paise)}`}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
