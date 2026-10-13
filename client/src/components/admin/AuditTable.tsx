import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AuditEntry } from '@/features/admin/api';
import { cn } from '@/lib/utils';

const SEVERITY: Record<AuditEntry['severity'], string> = {
  INFO: 'bg-muted text-muted-foreground',
  WARN: 'bg-accent/20 text-foreground',
  CRITICAL: 'bg-destructive/10 text-destructive',
};

const who = (p: AuditEntry['actor']) =>
  p ? (p.name ? `${p.name}${p.email ? ` (${p.email})` : ''}` : (p.email ?? p.id)) : 'system';

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-xs font-medium',
        SEVERITY[severity as AuditEntry['severity']] ?? SEVERITY.INFO,
      )}
    >
      {severity.toLowerCase()}
    </span>
  );
}

export function AuditList({ items }: { items: AuditEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y">
      {items.map((a) => (
        <li key={a.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="font-mono">{a.action}</span>
                <SeverityBadge severity={a.severity} />
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {who(a.actor)}
                {a.target && <> → {who(a.target)}</>} ·{' '}
                {new Date(a.createdAt).toLocaleString('en-IN', {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                })}
                {a.ipAddress && ` · ${a.ipAddress}`}
              </p>
            </div>
            {(a.metadata || a.userAgent || a.requestId) && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={open === a.id}
                onClick={() => setOpen(open === a.id ? null : a.id)}
              >
                {open === a.id ? 'Hide details' : 'Details'}
              </Button>
            )}
          </div>
          {open === a.id && (
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(
                {
                  requestId: a.requestId,
                  entity: a.entityType ? `${a.entityType}:${a.entityId}` : undefined,
                  userAgent: a.userAgent,
                  ...a.metadata,
                },
                null,
                2,
              )}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}
