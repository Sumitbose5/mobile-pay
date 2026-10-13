import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { notificationsApi, type AppNotification } from '@/features/notifications/api';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const query = useInfiniteQuery({
    queryKey: ['notifications', 'list', unreadOnly],
    queryFn: ({ pageParam }) => notificationsApi.list(pageParam, unreadOnly),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const markRead = useMutation({ mutationFn: notificationsApi.markRead, onSuccess: refresh });
  const markAll = useMutation({ mutationFn: notificationsApi.markAllRead, onSuccess: refresh });

  const open = (n: AppNotification) => {
    if (!n.isRead) markRead.mutate(n.id);
    if (n.data?.publicId) navigate(`/transactions/${n.data.publicId}`);
    else if (n.type.startsWith('REQUEST_')) navigate('/requests');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={unreadOnly ? 'default' : 'outline'}
            size="sm"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((v) => !v)}
          >
            Unread only
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={markAll.isPending || items.every((n) => n.isRead)}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {query.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
          {query.isError && <Notice tone="error">{errorMessage(query.error)}</Notice>}
          {query.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {unreadOnly
                ? 'You are all caught up.'
                : 'No notifications yet. Payments and account alerts will show up here.'}
            </p>
          )}
          <ul className="divide-y" aria-live="polite">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md px-2 py-3 text-left hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring',
                    !n.isRead && 'bg-accent/5',
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      n.isRead ? 'bg-transparent' : 'bg-accent',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn('block text-sm', n.isRead ? 'font-medium' : 'font-semibold')}
                    >
                      {n.title}
                      {!n.isRead && <span className="sr-only"> (unread)</span>}
                    </span>
                    <span className="block text-sm text-muted-foreground">{n.message}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {new Date(n.createdAt).toLocaleString('en-IN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                  </span>
                </button>
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
