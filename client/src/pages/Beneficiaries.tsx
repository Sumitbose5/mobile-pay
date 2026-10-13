import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Field, Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { beneficiariesApi, type Beneficiary } from '@/features/payments/api';
import { errorMessage } from '@/lib/api';

function BeneficiaryRow({ b }: { b: Beneficiary }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(b.nickname ?? '');
  const refresh = () => qc.invalidateQueries({ queryKey: ['beneficiaries'] });
  const rename = useMutation({
    mutationFn: () => beneficiariesApi.rename(b.id, nickname.trim() || null),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => beneficiariesApi.remove(b.id),
    onSuccess: refresh,
  });
  const title = b.nickname || b.user.name;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        {editing ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate();
            }}
          >
            <Field
              id={`nick-${b.id}`}
              label="Nickname"
              value={nickname}
              maxLength={100}
              onChange={(e) => setNickname(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={rename.isPending}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <p className="truncate text-sm font-medium">
              {title}
              {b.nickname && (
                <span className="ml-2 font-normal text-muted-foreground">{b.user.name}</span>
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">{b.user.email}</p>
          </>
        )}
        {(rename.isError || remove.isError) && (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage(rename.error ?? remove.error)}
          </p>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-2">
          <Button asChild size="sm">
            <Link to={`/send?to=${encodeURIComponent(b.user.email)}`}>Send</Link>
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Rename
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Remove ${title} from your beneficiaries?`)) remove.mutate();
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

export function Beneficiaries() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['beneficiaries'], queryFn: beneficiariesApi.list });
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [pin, setPin] = useState('');
  const add = useMutation({
    mutationFn: () =>
      beneficiariesApi.add({
        email: email.trim().toLowerCase(),
        nickname: nickname.trim() || undefined,
        pin,
      }),
    onSuccess: () => {
      setEmail('');
      setNickname('');
      void qc.invalidateQueries({ queryKey: ['beneficiaries'] });
    },
    onSettled: () => setPin(''),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Beneficiaries</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a beneficiary</CardTitle>
          <CardDescription>
            Save people you pay often. Adding someone needs your transaction PIN.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (email && pin.length >= 4) add.mutate();
            }}
          >
            {add.isError && (
              <div className="sm:col-span-2">
                <Notice tone="error">{errorMessage(add.error)}</Notice>
              </div>
            )}
            <Field
              id="b-email"
              label="Their MobilePay email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Field
              id="b-nick"
              label="Nickname (optional)"
              maxLength={100}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
            <Field
              id="b-pin"
              label="Transaction PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
            <div className="flex items-end">
              <Button type="submit" disabled={add.isPending || !email || pin.length < 4}>
                {add.isPending ? 'Adding...' : 'Add beneficiary'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {list.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
          {list.isError && <Notice tone="error">{errorMessage(list.error)}</Notice>}
          {list.data?.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No beneficiaries yet.</p>
          )}
          <ul className="divide-y">
            {list.data?.map((b) => (
              <BeneficiaryRow key={b.id} b={b} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
