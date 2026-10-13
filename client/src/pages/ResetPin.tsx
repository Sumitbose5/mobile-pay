import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Field, Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authApi } from '@/features/auth/api';
import { errorMessage } from '@/lib/api';

/** Landing page for the emailed "reset your transaction PIN" link. It needs a logged-in session. */
export function ResetPin() {
  const token = useSearchParams()[0].get('token');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({ mutationFn: () => authApi.resetPin({ token: token!, newPin: pin }) });
  const valid = /^(\d{4}|\d{6})$/.test(pin) && pin === confirm;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Reset your transaction PIN</CardTitle>
        <CardDescription>
          Choose a new 4 or 6 digit PIN. This also clears any PIN lock.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!token && <Notice tone="error">This reset link is missing its token.</Notice>}
        {reset.isError && <Notice tone="error">{errorMessage(reset.error)}</Notice>}
        {reset.isSuccess ? (
          <>
            <Notice tone="success">Your PIN has been reset.</Notice>
            <Button asChild className="w-full">
              <Link to="/dashboard">Back to wallet</Link>
            </Button>
          </>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && token) reset.mutate();
            }}
          >
            <Field
              id="np"
              label="New PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
            <Field
              id="np2"
              label="Confirm PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
              error={confirm && pin !== confirm ? 'PINs do not match' : undefined}
            />
            <Button type="submit" className="w-full" disabled={!valid || !token || reset.isPending}>
              {reset.isPending ? 'Saving...' : 'Reset PIN'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
