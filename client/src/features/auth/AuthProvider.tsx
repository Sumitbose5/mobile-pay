import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { authApi } from './api';
import { AuthContext, type AuthState } from './context';

const ME_KEY = ['me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  // 401 here simply means "not logged in" (the axios interceptor already tried a silent refresh).
  const { data: user, isPending } = useQuery({
    queryKey: ME_KEY,
    queryFn: () =>
      authApi.me().catch((e) => {
        if (e instanceof AxiosError && e.response?.status === 401) return null;
        throw e;
      }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const clearSession = useCallback(() => {
    qc.setQueryData(ME_KEY, null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  }, [qc]);

  useEffect(() => {
    window.addEventListener('coinhub:session-expired', clearSession);
    return () => window.removeEventListener('coinhub:session-expired', clearSession);
  }, [clearSession]);

  const value = useMemo<AuthState>(
    () => ({
      user: user ?? null,
      loading: isPending,
      login: async (email, password) => {
        const u = await authApi.login({ email, password });
        qc.setQueryData(ME_KEY, u);
        return u;
      },
      logout: async () => {
        await authApi.logout().catch(() => undefined);
        clearSession();
      },
    }),
    [user, isPending, qc, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
