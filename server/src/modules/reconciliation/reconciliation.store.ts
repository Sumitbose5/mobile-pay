import { getRedis } from '../../redis/client.js';
import { reconcile, type ReconciliationReport } from './reconciliation.service.js';

const KEY = 'reconciliation:latest';

export async function runAndStore(): Promise<ReconciliationReport> {
  const report = await reconcile();
  await getRedis().set(KEY, JSON.stringify(report));
  return report;
}

export async function latestReport(): Promise<ReconciliationReport | null> {
  const raw = await getRedis().get(KEY);
  return raw ? (JSON.parse(raw) as ReconciliationReport) : null;
}
