import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Field, Notice } from '@/components/common/forms';
import { PaymentLoader } from '@/components/common/PaymentLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/context';
import { walletApi } from '@/features/wallet/api';
import { errorMessage, toApiError } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/money';

const MIN = 1_000n; // Rs 10  (the server enforces the real, configurable limits)
const MAX = 5_000_000n; // Rs 50,000
const QUICK = ['100', '500', '1000', '5000'];

export function AddMoney() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [rupees, setRupees] = useState('');
  const [touched, setTouched] = useState(false);
  // One key per payment attempt: double-clicks and network retries reuse it, a new payment gets a new one.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const paise = parseRupeesToPaise(rupees);
  const problem =
    paise === null
      ? 'Enter an amount like 500 or 500.50'
      : paise < MIN
        ? 'Minimum is ₹10'
        : paise > MAX
          ? 'Maximum is ₹50,000 per payment'
          : null;

  const create = useMutation({
    mutationFn: () => walletApi.addMoney(paise!, idempotencyKey.current),
    onSuccess: (order) => {
      idempotencyKey.current = crypto.randomUUID();
      navigate(`/pay/${order.id}`);
    },
  });

  if (user && !user.hasTransactionPin) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Set a transaction PIN first</CardTitle>
          <CardDescription>A PIN protects every payment from your wallet.</CardDescription>
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
    <>
      <PaymentLoader
        isVisible={create.isPending}
        message={`Processing payment of ${rupees ? `₹${Number(rupees).toLocaleString('en-IN')}` : '...'}`}
      />
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Add money</CardTitle>
          <CardDescription>Funds arrive instantly after the payment succeeds.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!problem) create.mutate();
            }}
          >
            {create.isError && (
              <Notice tone="error">
                {toApiError(create.error).code === 'REQUEST_IN_PROGRESS'
                  ? 'Your payment is already being created. Please wait.'
                  : errorMessage(create.error)}
              </Notice>
            )}
            <Field
              id="amount"
              label="Amount (₹)"
              inputMode="decimal"
              autoComplete="off"
              placeholder="500"
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              error={touched ? (problem ?? undefined) : undefined}
              hint={paise !== null && !problem ? `You will add ${formatPaise(paise)}` : undefined}
              disabled={create.isPending}
            />
            <div className="flex flex-wrap gap-2">
              {QUICK.map((q) => (
                <Button
                  key={q}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRupees(q)}
                  disabled={create.isPending}
                >
                  ₹{Number(q).toLocaleString('en-IN')}
                </Button>
              ))}
            </div>
            <Button type="submit" variant="accent" className="w-full" disabled={create.isPending}>
              {create.isPending ? 'Creating payment...' : 'Continue to payment'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
