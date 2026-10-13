import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Field, Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requestsApi, type PaymentRequest, type RequestStatus } from '@/features/payments/api';
import { errorMessage, toApiError } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

const STATUS_STYLE: Record<RequestStatus, string> = {
  PENDING: 'bg-accent/15 text-foreground',
  PAID: 'bg-success/15 text-success',
  REJECTED: 'bg-destructive/10 text-destructive',
  CANCELLED: 'bg-muted text-muted-foreground',
  EXPIRED: 'bg-muted text-muted-foreground',
};

function RequestRow({ r, box }: { r: PaymentRequest; box: 'received' | 'sent' }) {
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [pin, setPin] = useState('');
  // One key per payment attempt: a double click or retry reuses it and can never pay twice.
  const key = useRef(crypto.randomUUID());
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['requests'] });
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
  };
  const pay = useMutation({
    mutationFn: () => requestsApi.pay(r.id, pin, key.current),
    onSuccess: () => {
      key.current = crypto.randomUUID();
      setPaying(false);
      refresh();
    },
    onSettled: () => setPin(''),
  });
  const reject = useMutation({ mutationFn: () => requestsApi.reject(r.id), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: () => requestsApi.cancel(r.id), onSuccess: refresh });

  const other = box === 'received' ? r.requester : r.payer;
  const error = pay.error ?? reject.error ?? cancel.error;
  const open = r.status === 'PENDING';

  return (
    <li className="space-y-3 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {box === 'received' ? `${other.name} requested` : `You requested from ${other.name}`}{' '}
            <span className="tabular-nums">{formatPaise(r.amount)}</span>
          </p>
          {r.note && <p className="truncate text-sm text-muted-foreground">“{r.note}”</p>}
          <p className="text-xs text-muted-foreground">
            {new Date(r.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
            {open &&
              ` · expires ${new Date(r.expiresAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}`}
            {r.transactionId && (
              <>
                {' '}
                ·{' '}
                <Link className="underline" to={`/transactions/${r.transactionId}`}>
                  view payment
                </Link>
              </>
            )}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium capitalize',
            STATUS_STYLE[r.status],
          )}
        >
          {r.status.toLowerCase()}
        </span>
      </div>

      {error && (
        <Notice tone="error">
          {toApiError(error).code === 'REQUEST_NOT_PENDING'
            ? 'This request was already settled. Refreshing.'
            : errorMessage(error)}
        </Notice>
      )}

      {open && box === 'received' && !paying && (
        <div className="flex gap-2">
          <Button size="sm" variant="accent" onClick={() => setPaying(true)}>
            Pay
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={reject.isPending}
            onClick={() => reject.mutate()}
          >
            Decline
          </Button>
        </div>
      )}
      {open && box === 'received' && paying && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length >= 4) pay.mutate();
          }}
        >
          <Field
            id={`pin-${r.id}`}
            label="Transaction PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
          <Button type="submit" variant="accent" disabled={pay.isPending || pin.length < 4}>
            {pay.isPending ? 'Paying...' : `Pay ${formatPaise(r.amount)}`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              pay.reset();
              setPaying(false);
              setPin('');
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {open && box === 'sent' && (
        <Button
          size="sm"
          variant="outline"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel request
        </Button>
      )}
    </li>
  );
}

function NewRequestForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [rupees, setRupees] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const paise = parseRupeesToPaise(rupees);
  const problem =
    paise === null
      ? 'Enter an amount like 250 or 250.50'
      : paise < 100n
        ? 'Minimum is ₹1'
        : paise > 5_000_000n
          ? 'Maximum is ₹50,000'
          : null;
  const create = useMutation({
    mutationFn: () =>
      requestsApi.create({
        payerEmail: email.trim().toLowerCase(),
        amount: paise!,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['requests'] });
      onDone();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Request money</CardTitle>
        <CardDescription>
          They get a notification and can pay or decline. Requests expire after 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (email && !problem) create.mutate();
          }}
        >
          {create.isError && (
            <div className="sm:col-span-2">
              <Notice tone="error">
                {toApiError(create.error).code === 'RESOURCE_NOT_FOUND'
                  ? 'No MobilePay user found with that email.'
                  : errorMessage(create.error)}
              </Notice>
            </div>
          )}
          <Field
            id="r-email"
            label="From (their email)"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            id="r-amount"
            label="Amount (₹)"
            inputMode="decimal"
            autoComplete="off"
            value={rupees}
            onChange={(e) => setRupees(e.target.value)}
            error={touched ? (problem ?? undefined) : undefined}
          />
          <div className="sm:col-span-2">
            <Field
              id="r-note"
              label="What is it for? (optional)"
              maxLength={255}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Sending...' : 'Send request'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function Requests() {
  const [box, setBox] = useState<'received' | 'sent'>('received');
  const [composing, setComposing] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ['requests', box],
    queryFn: ({ pageParam }) => requestsApi.list(box, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Payment requests</h1>
        <Button variant={composing ? 'outline' : 'accent'} onClick={() => setComposing((v) => !v)}>
          {composing ? 'Close' : 'Request money'}
        </Button>
      </div>
      {composing && (
        <NewRequestForm
          onDone={() => {
            setComposing(false);
            setBox('sent');
          }}
        />
      )}

      <div className="flex gap-2" role="tablist" aria-label="Request direction">
        {(['received', 'sent'] as const).map((b) => (
          <Button
            key={b}
            role="tab"
            aria-selected={box === b}
            size="sm"
            variant={box === b ? 'default' : 'outline'}
            onClick={() => setBox(b)}
          >
            {b === 'received' ? 'Requests to you' : 'Requests you sent'}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="pt-2">
          {query.isPending && <p className="py-4 text-sm text-muted-foreground">Loading...</p>}
          {query.isError && <Notice tone="error">{errorMessage(query.error)}</Notice>}
          {query.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {box === 'received'
                ? 'Nobody has requested money from you.'
                : 'You have not requested any money yet.'}
            </p>
          )}
          <ul className="divide-y" aria-live="polite">
            {items.map((r) => (
              <RequestRow key={r.id} r={r} box={box} />
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
