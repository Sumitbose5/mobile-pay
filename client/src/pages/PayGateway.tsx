import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { InlinePaymentLoader } from '@/components/common/PaymentLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { walletApi } from '@/features/wallet/api';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/money';

/** Stand-in for a hosted gateway checkout (Razorpay/Stripe). No real money is involved. */
export function PayGateway() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const order = useQuery({ queryKey: ['order', id], queryFn: () => walletApi.order(id) });
  const complete = useMutation({
    mutationFn: (outcome: 'SUCCESS' | 'FAILED') => walletApi.simulate(id, outcome),
    onSuccess: (o) => {
      qc.setQueryData(['order', id], o);
      void qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  const o = order.data;
  const finished = o && (o.status === 'SUCCESS' || o.status === 'FAILED');

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <p className="w-fit rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Simulated payment gateway
        </p>
        <CardTitle>{o ? `Pay ${formatPaise(o.amount)}` : 'Payment'}</CardTitle>
        <CardDescription>{o ? `Order ${o.gatewayOrderId}` : 'Loading order...'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {order.isLoading && (
          <InlinePaymentLoader isVisible={true} message="Loading payment details..." />
        )}
        {order.isError && <Notice tone="error">{errorMessage(order.error)}</Notice>}
        {complete.isError && <Notice tone="error">{errorMessage(complete.error)}</Notice>}
        {o?.status === 'SUCCESS' && (
          <Notice tone="success">
            Payment successful. {formatPaise(o.amount)} was added to your wallet.
          </Notice>
        )}
        {o?.status === 'FAILED' && (
          <Notice tone="error">
            Payment failed{o.failureReason ? ` (${o.failureReason.replace(/_/g, ' ')})` : ''}.
            Nothing was charged and your balance is unchanged.
          </Notice>
        )}
        {o && !finished && (
          <>
            {complete.isPending && (
              <InlinePaymentLoader
                isVisible={true}
                message={`Processing payment of ${formatPaise(o.amount)}`}
              />
            )}
            {!complete.isPending && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="accent"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate('SUCCESS')}
                >
                  Pay successfully
                </Button>
                <Button
                  variant="outline"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate('FAILED')}
                >
                  Fail the payment
                </Button>
              </div>
            )}
          </>
        )}
        {finished && (
          <Button asChild className="w-full">
            <Link to="/dashboard">Back to wallet</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
