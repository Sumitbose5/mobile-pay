import { cn } from '@/lib/utils';
import { CheckCircle2, AlertCircle, Loader } from 'lucide-react';

export interface PaymentLoaderProps {
  isVisible: boolean;
  message?: string;
  variant?: 'processing' | 'success' | 'error';
}

/**
 * Professional full-screen payment loader component.
 * Displays during payment processing with optional success/error states.
 * Prevents accidental interactions while payment is processing.
 */
export function PaymentLoader({
  isVisible,
  message = 'Processing payment...',
  variant = 'processing',
}: PaymentLoaderProps) {
  if (!isVisible) return null;

  const isSuccess = variant === 'success';
  const isError = variant === 'error';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-2xl sm:p-10">
        <div className="flex justify-center mb-6">
          {isSuccess ? (
            <div className="relative">
              <div className="absolute inset-0 animate-pulse rounded-full bg-green-100" />
              <CheckCircle2 className="relative size-16 text-green-600" strokeWidth={1.5} />
            </div>
          ) : isError ? (
            <div className="relative">
              <div className="absolute inset-0 animate-pulse rounded-full bg-red-100" />
              <AlertCircle className="relative size-16 text-red-600" strokeWidth={1.5} />
            </div>
          ) : (
            <Loader className="size-16 animate-spin text-accent" strokeWidth={1.5} />
          )}
        </div>

        <h2
          className={cn(
            'text-center text-lg font-semibold',
            isSuccess && 'text-green-600',
            isError && 'text-red-600',
            !isSuccess && !isError && 'text-foreground',
          )}
        >
          {message}
        </h2>

        {variant === 'processing' && (
          <p className="mt-3 text-center text-sm text-muted-foreground">
            Please do not close or navigate away
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Compact inline payment loader for use within cards/containers.
 * Ideal for embedded payment scenarios.
 */
export function InlinePaymentLoader({
  isVisible,
  message = 'Processing...',
  variant = 'processing',
}: PaymentLoaderProps) {
  if (!isVisible) return null;

  const isSuccess = variant === 'success';
  const isError = variant === 'error';

  return (
    <div className="flex flex-col items-center justify-center space-y-4 py-8">
      <div>
        {isSuccess ? (
          <CheckCircle2 className="size-10 text-green-600" strokeWidth={1.5} />
        ) : isError ? (
          <AlertCircle className="size-10 text-red-600" strokeWidth={1.5} />
        ) : (
          <Loader className="size-10 animate-spin text-accent" strokeWidth={1.5} />
        )}
      </div>

      <p
        className={cn(
          'text-center text-sm font-medium',
          isSuccess && 'text-green-600',
          isError && 'text-red-600',
          !isSuccess && !isError && 'text-foreground',
        )}
      >
        {message}
      </p>
    </div>
  );
}
