import { api } from '@/lib/api';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  data: { transactionId?: string; publicId?: string } | null;
  isRead: boolean;
  createdAt: string;
}

export const notificationsApi = {
  list: (cursor?: string, unread?: boolean, limit = 20) =>
    api
      .get<{ data: { items: AppNotification[]; nextCursor: string | null } }>('/notifications', {
        params: { cursor, limit, unread: unread ? 'true' : undefined },
      })
      .then((r) => r.data.data),
  unreadCount: () =>
    api
      .get<{ data: { count: number } }>('/notifications/unread-count')
      .then((r) => r.data.data.count),
  markRead: (id: string) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.post('/notifications/read-all'),
};
