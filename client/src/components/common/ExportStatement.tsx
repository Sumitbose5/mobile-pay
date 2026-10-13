import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/common/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { reportsApi } from '@/features/payments/api';
import { errorMessage } from '@/lib/api';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const startOfDay = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const endOfDay = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

/** Requests a CSV statement; a worker builds it, this polls until it is ready, then downloads it. */
export function ExportStatement() {
  const today = new Date();
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [reportId, setReportId] = useState<string | null>(null);

  const request = useMutation({
    mutationFn: () => reportsApi.request(startOfDay(from), endOfDay(to)),
    onSuccess: (r) => setReportId(r.id),
  });
  const status = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => reportsApi.status(reportId!),
    enabled: !!reportId,
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' || !q.state.data ? 1_000 : false),
  });
  const download = useMutation({
    mutationFn: () =>
      reportsApi.download(status.data!.id, status.data!.filename ?? 'statement.csv'),
  });

  // Choosing a different range starts a fresh request.
  useEffect(() => setReportId(null), [from, to]);

  const s = status.data;
  const pending = request.isPending || (!!reportId && (!s || s.status === 'PENDING'));
  const invalid = !from || !to || from > to;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Download a statement</CardTitle>
        <CardDescription>
          A CSV of your transactions for a date range (up to a year).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="s-from">From</Label>
            <Input
              id="s-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-to">To</Label>
            <Input
              id="s-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              className="w-full"
              disabled={pending || invalid}
              onClick={() => request.mutate()}
            >
              {pending ? 'Preparing...' : 'Prepare statement'}
            </Button>
          </div>
        </div>
        {request.isError && <Notice tone="error">{errorMessage(request.error)}</Notice>}
        {s?.status === 'FAILED' && (
          <Notice tone="error">We could not prepare that statement. Please try again.</Notice>
        )}
        {download.isError && <Notice tone="error">{errorMessage(download.error)}</Notice>}
        {s?.status === 'READY' && (
          <Notice tone="success">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Your statement is ready ({s.rows} transaction{s.rows === 1 ? '' : 's'}).
              </span>
              <Button size="sm" disabled={download.isPending} onClick={() => download.mutate()}>
                Download CSV
              </Button>
            </span>
          </Notice>
        )}
      </CardContent>
    </Card>
  );
}
