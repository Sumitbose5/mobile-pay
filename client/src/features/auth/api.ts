import { api } from '@/lib/api';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'USER' | 'ADMIN';
  status: string;
  emailVerified: boolean;
  hasTransactionPin: boolean;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  device: string | null;
  ip: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  current: boolean;
}

export interface NotificationPreferences {
  emailMoneyReceived: boolean;
  emailMoneySent: boolean;
  emailPaymentRequests: boolean;
  emailMarketing: boolean;
}

export const authApi = {
  register: (body: { name: string; email: string; password: string }) =>
    api.post('/auth/register', body),
  verifyEmail: (token: string) => api.post('/auth/verify-email', { token }),
  resendVerification: (email: string) => api.post('/auth/resend-verification', { email }),
  login: (body: { email: string; password: string }) =>
    api.post<{ data: { user: User } }>('/auth/login', body).then((r) => r.data.data.user),
  logout: () => api.post('/auth/logout'),
  forgotPassword: (email: string) => api.post('/auth/forgot-password', { email }),
  resetPassword: (body: { token: string; password: string }) =>
    api.post('/auth/reset-password', body),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    api.post('/auth/change-password', body),
  setPin: (body: { password: string; pin: string }) => api.post('/users/me/pin', body),
  changePin: (body: { currentPin: string; newPin: string }) => api.put('/users/me/pin', body),
  requestPinReset: (password: string) => api.post('/users/me/pin/reset-request', { password }),
  resetPin: (body: { token: string; newPin: string }) => api.post('/users/me/pin/reset', body),
  me: () => api.get<{ data: { user: User } }>('/users/me').then((r) => r.data.data.user),
  updateProfile: (name: string) =>
    api.patch<{ data: { user: User } }>('/users/me', { name }).then((r) => r.data.data.user),
  sessions: () =>
    api
      .get<{ data: { sessions: SessionInfo[] } }>('/auth/sessions')
      .then((r) => r.data.data.sessions),
  revokeSession: (id: string) => api.delete(`/auth/sessions/${id}`),
  preferences: () =>
    api
      .get<{ data: { preferences: NotificationPreferences } }>('/users/me/notification-preferences')
      .then((r) => r.data.data.preferences),
  updatePreferences: (body: Partial<NotificationPreferences>) =>
    api
      .patch<{ data: { preferences: NotificationPreferences } }>(
        '/users/me/notification-preferences',
        body,
      )
      .then((r) => r.data.data.preferences),
};
