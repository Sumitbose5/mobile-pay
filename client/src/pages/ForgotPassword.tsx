import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { AuthCard, Field, Notice } from '@/components/common/forms';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { authApi } from '@/features/auth/api';
import { emailField } from '@/features/auth/schemas';

const schema = z.object({ email: emailField });

export function ForgotPassword() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    try {
      await authApi.forgotPassword(email);
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <AuthCard
      title="Reset your password"
      description="We will email you a link if the account exists."
      footer={
        <Link className="underline" to="/login">
          Back to log in
        </Link>
      }
    >
      {done ? (
        <Notice tone="success">
          If an account exists for that email, a reset link is on its way. It expires in 30 minutes.
        </Notice>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <Notice tone="error">{error}</Notice>}
          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register('email')}
          />
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Sending...' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
