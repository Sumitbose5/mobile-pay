import { ArrowDownLeft, ArrowUpRight, Landmark, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Direction, TransactionItem, TxnStatus } from '@/features/transactions/api';
import { cn } from '@/lib/utils';
import { directionLabel } from '@/features/transactions/labels';
import { formatPaise } from '@/lib/money';

const STATUS_STYLE: Record<TxnStatus, string> = {
  SUCCESS: 'bg-success/15 text-success',
  PENDING: 'bg-muted text-muted-foreground',
  PROCESSING: 'bg-muted text-muted-foreground',
  FAILED: 'bg-destructive/10 text-destructive',
  CANCELLED: 'bg-muted text-muted-foreground',
};

export function StatusBadge({ status }: { status: TxnStatus }) {
  return (
    <span
      className={cn('rounded px-1.5 py-0.5 text-xs font-medium capitalize', STATUS_STYLE[status])}
    >
      {status.toLowerCase()}
    </span>
  );
}

const DIRECTION_ICON: Record<Direction, typeof Plus> = {
  SENT: ArrowUpRight,
  RECEIVED: ArrowDownLeft,
  ADDED: Plus,
  WITHDRAWN: Landmark,
};

/** + green for money in, minus for money out; failed attempts moved nothing so the amount is struck through. */
export function AmountText({
  item,
  className,
}: {
  item: Pick<TransactionItem, 'signedAmount' | 'amount' | 'status'>;
  className?: string;
}) {
  if (item.status !== 'SUCCESS') {
    return (
      <span className={cn('tabular-nums text-muted-foreground line-through', className)}>
        {formatPaise(item.amount)}
      </span>
    );
  }
  const value = BigInt(item.signedAmount);
  return (
    <span
      className={cn(
        'tabular-nums font-medium',
        value > 0n ? 'text-success' : 'text-foreground',
        className,
      )}
    >
      {value > 0n ? '+' : value < 0n ? '-' : ''}
      {formatPaise(value < 0n ? -value : value)}
    </span>
  );
}

export function TransactionRow({ item }: { item: TransactionItem }) {
  const Icon = DIRECTION_ICON[item.direction];
  return (
    <li>
      <Link
        to={`/transactions/${item.id}`}
        className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted" aria-hidden>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{directionLabel(item)}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {new Date(item.createdAt).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
            {item.note ? ` - ${item.note}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <AmountText item={item} className="text-sm" />
          {item.status !== 'SUCCESS' && <StatusBadge status={item.status} />}
        </span>
      </Link>
    </li>
  );
}
