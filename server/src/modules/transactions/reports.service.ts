import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { paiseToRupees } from '../../lib/money.js';
import { enqueueReport } from '../../queues/jobs.js';
import { getRedis } from '../../redis/client.js';
import { createNotification } from '../notifications/notifications.service.js';
import { getWalletForUser } from '../wallet/wallet.service.js';
import { listTransactions } from './transactions.service.js';

const TTL_SECONDS = 3_600;
const MAX_ROWS = 20_000;
const MAX_RANGE_DAYS = 366;
const key = (id: string) => `report:${id}`;

export const exportBody = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((v) => v.to >= v.from, { message: 'End date must be on or after the start date', path: ['to'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= MAX_RANGE_DAYS * 86_400_000, { message: `Choose a range of at most ${MAX_RANGE_DAYS} days`, path: ['to'] });

interface ReportMeta {
  userId: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  from: string;
  to: string;
  createdAt: string;
  rows?: number;
  filename?: string;
  csv?: string;
  error?: string;
}

const save = (id: string, meta: ReportMeta) => getRedis().set(key(id), JSON.stringify(meta), 'EX', TTL_SECONDS);

export async function requestExport(userId: string, range: { from: Date; to: Date }) {
  await getWalletForUser(userId);
  const id = randomUUID();
  await save(id, { userId, status: 'PENDING', from: range.from.toISOString(), to: range.to.toISOString(), createdAt: new Date().toISOString() });
  await enqueueReport(id);
  return { id, status: 'PENDING' as const };
}

async function load(userId: string, id: string): Promise<ReportMeta> {
  const raw = await getRedis().get(key(id));
  const meta = raw ? (JSON.parse(raw) as ReportMeta) : null;
  // Someone else's report looks exactly like a missing or expired one.
  if (!meta || meta.userId !== userId) throw new AppError('RESOURCE_NOT_FOUND', 'Report not found or expired');
  return meta;
}

export async function getReportStatus(userId: string, id: string) {
  const m = await load(userId, id);
  // The CSV body is only served by the download endpoint, never in the status response.
  return { id, status: m.status, from: m.from, to: m.to, createdAt: m.createdAt, rows: m.rows, filename: m.filename, error: m.error };
}

export async function getReportFile(userId: string, id: string) {
  const meta = await load(userId, id);
  if (meta.status !== 'READY' || !meta.csv) throw new AppError('REQUEST_NOT_PENDING', 'This statement is not ready yet');
  return { filename: meta.filename ?? 'statement.csv', csv: meta.csv };
}

/** Spreadsheet formula injection: a cell that starts with = + - @ (or tab/CR) is prefixed so it is read as text. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Numeric columns are written as plain numbers. They come from our own integer math, never from user input, so the
 * formula guard above must NOT apply: it would turn "-250.50" into the text "'-250.50" and break spreadsheet totals.
 */
export function csvNumber(paise: bigint): string {
  return paiseToRupees(paise);
}

const HEADER = ['Date (UTC)', 'Transaction ID', 'Type', 'Direction', 'Counterparty', 'Counterparty email', 'Note', 'Status', 'Amount (INR)', 'Effect on balance (INR)'];

/** Worker side: builds the CSV with the same visibility rules as the history screen. */
export async function generateReport(reportId: string): Promise<void> {
  const raw = await getRedis().get(key(reportId));
  if (!raw) return; // expired before the worker ran
  const meta = JSON.parse(raw) as ReportMeta;
  if (meta.status !== 'PENDING') return; // idempotent: a retried job does not rebuild a finished report
  try {
    const lines = [HEADER.join(',')];
    let cursor: string | undefined;
    let rows = 0;
    do {
      const page = await listTransactions(meta.userId, { limit: 500, from: new Date(meta.from), to: new Date(meta.to), ...(cursor ? { cursor } : {}) });
      for (const t of page.items) {
        lines.push(
          [t.createdAt.toISOString(), t.id, t.type, t.direction, t.counterparty?.name, t.counterparty?.email, t.note, t.status].map(csvCell).concat([csvNumber(t.amount), csvNumber(t.signedAmount)]).join(','),
        );
        rows++;
      }
      cursor = page.nextCursor ?? undefined;
      if (rows >= MAX_ROWS) break;
    } while (cursor);

    const filename = `coinhub-statement-${meta.from.slice(0, 10)}-to-${meta.to.slice(0, 10)}.csv`;
    await save(reportId, { ...meta, status: 'READY', rows, filename, csv: lines.join('\r\n') + '\r\n' });
    await createNotification({
      userId: meta.userId,
      type: 'REPORT_READY',
      title: 'Statement ready',
      message: `Your statement for ${meta.from.slice(0, 10)} to ${meta.to.slice(0, 10)} is ready to download (${rows} transaction${rows === 1 ? '' : 's'}).`,
      data: { reportId },
      dedupeKey: `report-${reportId}`,
    });
  } catch (err) {
    logger.error({ err, reportId }, 'Report generation failed');
    await save(reportId, { ...meta, status: 'FAILED', error: 'Could not generate the statement' });
    throw err;
  }
}

