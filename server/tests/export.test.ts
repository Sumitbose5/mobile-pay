process.env.QUEUE_PREFIX = `test-${Math.random().toString(36).slice(2, 8)}`;

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db } = await import('../src/db/client.js');
const { notifications } = await import('../src/db/schema/index.js');
const { startBackgroundJobs } = await import('../src/jobs/workers.js');
const { csvCell, csvNumber } = await import('../src/modules/transactions/reports.service.js');
const { closeQueues, getQueue, QUEUES } = await import('../src/queues/queues.js');
const { closeRedis, getRedis } = await import('../src/redis/client.js');
const { browser, ensureSystemWallet, fund, newUser, send } = await import('./helpers.js');
type TestUser = Awaited<ReturnType<typeof newUser>>;

let jobs: { stop: () => Promise<void> };
beforeAll(async () => {
  await ensureSystemWallet();
  jobs = startBackgroundJobs({ outbox: false });
});
afterAll(async () => {
  await jobs.stop();
  for (const name of Object.values(QUEUES)) await getQueue(name).obliterate({ force: true }).catch(() => undefined);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

const range = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
async function waitReady(u: TestUser, id: string) {
  const end = Date.now() + 8_000;
  for (;;) {
    const s = (await u.b.get(`/api/v1/transactions/export/${id}`)).body.data.report;
    if (s.status !== 'PENDING') return s;
    if (Date.now() > end) throw new Error('report never finished');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('csvCell', () => {
  it('quotes separators and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    for (const f of ['+1+1', '-2+3', '@SUM(A1)']) expect(csvCell(f)).toBe(`'${f}`);
    expect(csvCell(null)).toBe('');
    expect(csvCell(12345)).toBe('12345');
  });

  it('writes amounts as real numbers, including negatives, so spreadsheets can sum them', () => {
    expect(csvNumber(-25_050n)).toBe('-250.50');
    expect(csvNumber(0n)).toBe('0.00');
    expect(csvNumber(100_000n)).toBe('1000.00');
  });
});

describe('statement export', () => {
  it('builds a CSV in the worker and serves it to its owner only', async () => {
    const [a, b, c] = [await newUser({ name: 'Sumit, Kumar' }), await newUser({ name: 'Rahul Sharma' }), await newUser()];
    await fund(a, 500_000);
    expect((await send(a, b, 25_050, { note: '=HYPERLINK("http://evil","pay")' })).status).toBe(201);
    expect((await send(a, b, 10_000, { note: 'Dinner, "good" one' })).status).toBe(201);
    expect((await send(c, a, 999_999)).status).toBe(422); // c's FAILED attempt to pay a must NOT appear in a's statement

    const req = await a.b.post('/api/v1/transactions/export', range());
    expect(req.status).toBe(202);
    const id = req.body.data.report.id as string;
    const status = await waitReady(a, id);
    expect(status).toMatchObject({ status: 'READY', rows: 3 });
    expect(status).not.toHaveProperty('csv');

    const file = await a.b.raw(`/api/v1/transactions/export/${id}/download`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['content-disposition']).toMatch(/attachment; filename="coinhub-statement-.*\.csv"/);
    expect(file.headers['cache-control']).toBe('no-store');
    const lines = file.text.trim().split('\r\n');
    expect(lines[0]).toBe('Date (UTC),Transaction ID,Type,Direction,Counterparty,Counterparty email,Note,Status,Amount (INR),Effect on balance (INR)');
    expect(lines).toHaveLength(4); // header + add money + 2 transfers; no failed attempt from someone else
    expect(file.text).toContain(`'=HYPERLINK`); // formula neutralised
    expect(file.text).toContain('"Dinner, ""good"" one"');
    expect(file.text).toContain(',250.50,-250.50\r\n'); // numeric columns are plain numbers, not guarded text
    expect(file.text).not.toContain("'-250.50");
    expect(file.text).toContain('5000.00,5000.00'); // add money: +
    expect(file.text).not.toContain('9999.99');

    const note = await waitFor2(async () => (await db.select().from(notifications).where(eq(notifications.userId, a.userId))).find((n) => n.type === 'REPORT_READY'));
    expect(note.message).toContain('3 transactions');

    expect((await b.b.get(`/api/v1/transactions/export/${id}`)).status).toBe(404); // someone else's report looks missing
    expect((await b.b.raw(`/api/v1/transactions/export/${id}/download`)).status).toBe(404);
    expect((await browser().get(`/api/v1/transactions/export/${id}`)).status).toBe(401);
  });

  it('applies the date range, refuses a download before it is ready, and validates the range', async () => {
    const [a, b] = [await newUser(), await newUser()];
    await fund(a, 500_000);
    await send(a, b, 10_000);
    const future = { from: new Date(Date.now() + 5 * 86_400_000).toISOString(), to: new Date(Date.now() + 6 * 86_400_000).toISOString() };
    const id = (await a.b.post('/api/v1/transactions/export', future)).body.data.report.id as string;
    expect(await waitReady(a, id)).toMatchObject({ status: 'READY', rows: 0 });
    expect((await a.b.raw(`/api/v1/transactions/export/${id}/download`)).text.trim().split('\r\n')).toHaveLength(1); // header only

    // a report that has not finished: simulate by creating a PENDING record directly
    const pendingId = '11111111-1111-4111-8111-111111111111';
    await getRedis().set(`report:${pendingId}`, JSON.stringify({ userId: a.userId, status: 'PENDING', from: future.from, to: future.to, createdAt: new Date().toISOString() }), 'EX', 60);
    expect((await a.b.raw(`/api/v1/transactions/export/${pendingId}/download`)).status).toBe(409);

    expect((await a.b.post('/api/v1/transactions/export', { from: future.to, to: future.from })).status).toBe(400);
    expect((await a.b.post('/api/v1/transactions/export', { from: '2020-01-01', to: '2022-01-01' })).status).toBe(400); // over a year
    expect((await a.b.post('/api/v1/transactions/export', { from: 'nope', to: 'nope' })).status).toBe(400);
  });
});

async function waitFor2<T>(fn: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}
