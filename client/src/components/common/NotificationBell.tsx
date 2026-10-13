import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { notificationsApi } from '@/features/notifications/api';

/** Bell with an unread badge. Polls every 30 s; the server answers from a Redis-cached count. */
export function NotificationBell() {
  const { data: count = 0 } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  return (
    <Link
      to="/notifications"
      className="relative grid size-9 place-items-center rounded-md hover:bg-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
    >
      <Bell className="size-5" aria-hidden />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-foreground">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
