import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { AuthCard, Field, Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { toApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/context';
import { authApi } from '@/features/auth/api';
import { emailField } from '@/features/auth/schemas';

const schema = z.object({ email: emailField, password: z.string().min(1, 'Enter your password') });
type Values = z.infer<typeof schema>;

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/dashboard';
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setUnverified(null);
    try {
      await login(values.email, values.password);
      navigate(from, { replace: true });
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'EMAIL_NOT_VERIFIED') setUnverified(values.email);
      setError(err.message);
    }
  });

  return (
    <AuthCard
      title="Welcome back"
      description="Log in to your MobilePay wallet."
      footer={
        <>
          New to MobilePay?{' '}
          <Link className="font-medium text-foreground underline" to="/register">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        {unverified && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={resent}
            onClick={async () => {
              await authApi.resendVerification(unverified).catch(() => undefined);
              setResent(true);
            }}
          >
            {resent ? 'Verification email sent' : 'Resend verification email'}
          </Button>
        )}
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <div className="text-right text-sm">
          <Link className="text-muted-foreground underline" to="/forgot-password">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Logging in...' : 'Log in'}
        </Button>
      </form>
    </AuthCard>
  );
}
