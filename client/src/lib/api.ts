import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: { fieldErrors?: Record<string, string[]> } & Record<string, unknown>;
  requestId?: string;
}

export const api = axios.create({
  baseURL: `${import.meta.env.VITE_API_URL ?? ''}/api/v1`,
  withCredentials: true, // auth lives in HttpOnly cookies, never in localStorage
  headers: { 'Content-Type': 'application/json' },
});

/** Normalises the server error envelope { success:false, error } into one shape. */
export function toApiError(err: unknown): ApiErrorBody {
  if (err instanceof AxiosError && err.response?.data?.error) {
    return err.response.data.error as ApiErrorBody;
  }
  return { code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' };
}

/** Human-readable message from any thrown API error. */
export const errorMessage = (e: unknown): string => toApiError(e).message;

// ---- CSRF: double-submit cookie. The server sets `csrf_token`; we echo it in a header. ----
function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

let csrfInFlight: Promise<unknown> | null = null;
async function ensureCsrfCookie(): Promise<void> {
  if (readCookie('csrf_token')) return;
  csrfInFlight ??= api.get('/auth/csrf').finally(() => (csrfInFlight = null));
  await csrfInFlight;
}

const UNSAFE = new Set(['post', 'put', 'patch', 'delete']);
api.interceptors.request.use(async (config) => {
  if (UNSAFE.has((config.method ?? 'get').toLowerCase())) {
    await ensureCsrfCookie();
    const token = readCookie('csrf_token');
    if (token) config.headers.set('x-csrf-token', decodeURIComponent(token));
  }
  return config;
});

// ---- Silent refresh: on 401, rotate the refresh token once (single flight) and retry. ----
type Retryable = InternalAxiosRequestConfig & { _retried?: boolean };
let refreshInFlight: Promise<void> | null = null;
const NO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout', '/auth/csrf'];

api.interceptors.response.use(
  (res) => res,
  async (error: unknown) => {
    if (!(error instanceof AxiosError) || !error.config) throw error;
    const original = error.config as Retryable;
    const url = original.url ?? '';
    if (
      error.response?.status !== 401 ||
      original._retried ||
      NO_REFRESH.some((p) => url.startsWith(p))
    ) {
      throw error;
    }
    original._retried = true;
    refreshInFlight ??= api
      .post('/auth/refresh')
      .then(() => undefined)
      .finally(() => (refreshInFlight = null));
    try {
      await refreshInFlight;
    } catch {
      window.dispatchEvent(new Event('coinhub:session-expired'));
      throw error;
    }
    return api(original);
  },
);
