import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthCard, Notice } from '@/components/common/forms';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { authApi } from '@/features/auth/api';

type State = { status: 'pending' } | { status: 'ok' } | { status: 'error'; message: string };

export function VerifyEmail() {
  const token = useSearchParams()[0].get('token');
  const [state, setState] = useState<State>(
    token ? { status: 'pending' } : { status: 'error', message: 'This link is missing its token.' },
  );
  const started = useRef(false); // StrictMode double-invokes effects; the token is single-use

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    authApi.verifyEmail(token).then(
      () => setState({ status: 'ok' }),
      (e) => setState({ status: 'error', message: errorMessage(e) }),
    );
  }, [token]);

  return (
    <AuthCard title="Email verification">
      {state.status === 'pending' && <Notice>Verifying your email...</Notice>}
      {state.status === 'ok' && (
        <>
          <Notice tone="success">Your email is verified and your wallet is ready.</Notice>
          <Button asChild className="w-full">
            <Link to="/login">Log in</Link>
          </Button>
        </>
      )}
      {state.status === 'error' && (
        <>
          <Notice tone="error">{state.message}</Notice>
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Back to log in</Link>
          </Button>
        </>
      )}
    </AuthCard>
  );
}
