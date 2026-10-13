import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Field, Notice } from '@/components/common/forms';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/features/auth/context';
import { authApi, type NotificationPreferences } from '@/features/auth/api';
import { passwordField } from '@/features/auth/schemas';

function ProfileCard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(user?.name ?? '');
  const save = useMutation({
    mutationFn: () => authApi.updateProfile(name.trim()),
    onSuccess: (u) => qc.setQueryData(['me'], u),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>{user?.email}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field
          id="profile-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {save.isError && <Notice tone="error">{errorMessage(save.error)}</Notice>}
        {save.isSuccess && <Notice tone="success">Profile updated.</Notice>}
        <Button
          disabled={save.isPending || name.trim().length < 2 || name.trim() === user?.name}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

const setPinSchema = z.object({
  password: z.string().min(1, 'Enter your password'),
  pin: z.string().regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits'),
});
const changePinSchema = z.object({
  currentPin: z.string().regex(/^(\d{4}|\d{6})$/, 'Enter your current PIN'),
  newPin: z.string().regex(/^(\d{4}|\d{6})$/, 'PIN must be 4 or 6 digits'),
});

function ForgotPin() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const request = useMutation({
    mutationFn: () => authApi.requestPinReset(password),
    onSettled: () => setPassword(''),
  });
  if (request.isSuccess)
    return (
      <Notice tone="success">
        Check your email for a link to reset your PIN. It is valid for 30 minutes.
      </Notice>
    );
  if (!open) {
    return (
      <button
        type="button"
        className="block text-sm text-muted-foreground underline"
        onClick={() => setOpen(true)}
      >
        Forgot your PIN?
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">
        Confirm your account password and we will email you a reset link.
      </p>
      {request.isError && <Notice tone="error">{errorMessage(request.error)}</Notice>}
      <Field
        id="forgot-pin-password"
        label="Account password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={request.isPending || !password}
          onClick={() => request.mutate()}
        >
          Email me a reset link
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PinCard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const hasPin = user?.hasTransactionPin ?? false;
  const setForm = useForm<z.infer<typeof setPinSchema>>({ resolver: zodResolver(setPinSchema) });
  const changeForm = useForm<z.infer<typeof changePinSchema>>({
    resolver: zodResolver(changePinSchema),
  });
  const setPin = useMutation({
    mutationFn: authApi.setPin,
    onSuccess: () => {
      setForm.reset();
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const changePin = useMutation({
    mutationFn: authApi.changePin,
    onSuccess: () => changeForm.reset(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transaction PIN</CardTitle>
        <CardDescription>
          {hasPin
            ? 'Required to authorise payments. Three wrong attempts lock it for 30 minutes.'
            : 'Set a 4 or 6 digit PIN. It is separate from your password.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasPin ? (
          <form
            className="space-y-3"
            noValidate
            onSubmit={setForm.handleSubmit((v) => setPin.mutate(v))}
          >
            {setPin.isError && <Notice tone="error">{errorMessage(setPin.error)}</Notice>}
            <Field
              id="pin-password"
              label="Account password"
              type="password"
              autoComplete="current-password"
              error={setForm.formState.errors.password?.message}
              {...setForm.register('password')}
            />
            <Field
              id="pin-new"
              label="New PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              error={setForm.formState.errors.pin?.message}
              {...setForm.register('pin')}
            />
            <Button type="submit" disabled={setPin.isPending}>
              Set PIN
            </Button>
          </form>
        ) : (
          <form
            className="space-y-3"
            noValidate
            onSubmit={changeForm.handleSubmit((v) => changePin.mutate(v))}
          >
            {changePin.isError && <Notice tone="error">{errorMessage(changePin.error)}</Notice>}
            {changePin.isSuccess && <Notice tone="success">PIN changed.</Notice>}
            <Field
              id="pin-current"
              label="Current PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              error={changeForm.formState.errors.currentPin?.message}
              {...changeForm.register('currentPin')}
            />
            <Field
              id="pin-change-new"
              label="New PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              error={changeForm.formState.errors.newPin?.message}
              {...changeForm.register('newPin')}
            />
            <Button type="submit" disabled={changePin.isPending}>
              Change PIN
            </Button>
            <ForgotPin />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordField,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Choose a different password',
  });

function PasswordCard() {
  const qc = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });
  const change = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: () => {
      reset();
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>Other devices are signed out when you change it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" noValidate onSubmit={handleSubmit((v) => change.mutate(v))}>
          {change.isError && <Notice tone="error">{errorMessage(change.error)}</Notice>}
          {change.isSuccess && <Notice tone="success">Password changed.</Notice>}
          <Field
            id="current"
            label="Current password"
            type="password"
            autoComplete="current-password"
            error={errors.currentPassword?.message}
            {...register('currentPassword')}
          />
          <Field
            id="new"
            label="New password"
            type="password"
            autoComplete="new-password"
            error={errors.newPassword?.message}
            {...register('newPassword')}
          />
          <Button type="submit" disabled={change.isPending}>
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: authApi.sessions });
  const revoke = useMutation({
    mutationFn: authApi.revokeSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>Devices currently signed in to your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessions.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
        {sessions.isError && <Notice tone="error">{errorMessage(sessions.error)}</Notice>}
        <ul className="divide-y">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {s.device ?? 'Unknown device'}
                  {s.current && (
                    <span className="ml-2 rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">
                      This device
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.ip ?? 'unknown IP'} - last active{' '}
                  {s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : 'never'}
                </p>
              </div>
              {!s.current && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(s.id)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const PREFS: { key: keyof NotificationPreferences; label: string }[] = [
  { key: 'emailMoneyReceived', label: 'Email me when I receive money' },
  { key: 'emailMoneySent', label: 'Email me when I send money' },
  { key: 'emailPaymentRequests', label: 'Email me about payment requests' },
  { key: 'emailMarketing', label: 'Product news and tips' },
];

function PreferencesCard() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ['preferences'], queryFn: authApi.preferences });
  const update = useMutation({
    mutationFn: authApi.updatePreferences,
    onSuccess: (p) => qc.setQueryData(['preferences'], p),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Security emails are always sent.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {PREFS.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-3">
            <input
              id={key}
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              disabled={!prefs.data || update.isPending}
              checked={prefs.data?.[key] ?? false}
              onChange={(e) => update.mutate({ [key]: e.target.checked })}
            />
            <Label htmlFor={key} className="font-normal">
              {label}
            </Label>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function Security() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Account and security</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <ProfileCard />
        <PinCard />
        <PasswordCard />
        <SessionsCard />
        <PreferencesCard />
      </div>
    </div>
  );
}
