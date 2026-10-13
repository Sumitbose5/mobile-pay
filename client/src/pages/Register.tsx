import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { AuthCard, Field, Notice } from '@/components/common/forms';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { authApi } from '@/features/auth/api';
import { emailField, passwordField } from '@/features/auth/schemas';

const schema = z
  .object({
    name: z.string().trim().min(2, 'Enter your name').max(100),
    email: emailField,
    password: passwordField,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });
type Values = z.infer<typeof schema>;

export function Register() {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async ({ name, email, password }) => {
    setError(null);
    try {
      await authApi.register({ name, email, password });
      setSentTo(email);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  if (sentTo) {
    return (
      <AuthCard
        title="Check your inbox"
        description={`We sent a verification link to ${sentTo}.`}
        footer={
          <Link className="underline" to="/login">
            Back to log in
          </Link>
        }
      >
        <Notice tone="success">
          Verify your email to activate your wallet. The link is valid for 24 hours.
        </Notice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      description="A wallet is created when you verify your email."
      footer={
        <>
          Already have an account?{' '}
          <Link className="font-medium text-foreground underline" to="/login">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        <Field
          id="name"
          label="Full name"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />
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
          autoComplete="new-password"
          hint="8+ characters with upper, lower case and a number"
          error={errors.password?.message}
          {...register('password')}
        />
        <Field
          id="confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...register('confirm')}
        />
        <Button type="submit" variant="accent" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Creating...' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
