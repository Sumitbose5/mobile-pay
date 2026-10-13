import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';

export interface Check {
  name: string;
  description: string;
  ok: boolean;
  /** At most 20 offending rows, enough to investigate. */
  violations: Record<string, unknown>[];
  violationCount: number;
}

export interface ReconciliationReport {
  ok: boolean;
  scope: 'full' | 'wallets';
  ranAt: string;
  durationMs: number;
  checks: Check[];
}

const SAMPLE = 20;
const STUCK_AFTER_MINUTES = 10;

async function run(name: string, description: string, query: SQL): Promise<Check> {
  const res = await db.execute(query);
  const rows = res.rows as Record<string, unknown>[];
  return { name, description, ok: rows.length === 0, violationCount: rows.length, violations: rows.slice(0, SAMPLE) };
}

/**
 * Proves the books balance. Every check is a read-only query that returns the rows that BREAK a rule, so an
 * empty result is a pass. `walletIds` narrows the checks to those wallets (used by tests, where unrelated
 * fixtures share the database); with no argument the whole system is checked, including global conservation.
 *
 * Invariants (see PRD section 3.13):
 *  1. wallet balance equals the net of its ledger entries
 *  2. each wallet's ledger forms an unbroken chain (balance_before = the previous balance_after)
 *  3. every transaction's debits equal its credits
 *  4. a SUCCESS transaction has exactly one DEBIT (sender) and one CREDIT (receiver) of its amount;
 *     FAILED, CANCELLED and PENDING ones have no ledger entries
 *  5. no user wallet is negative
 *  6. no transaction is stuck in flight
 *  7. (full only) all wallet balances sum to zero: money is only moved, never created
 *  8. (full only) every wallet's first ledger entry starts from a zero balance
 */
export async function reconcile(opts: { walletIds?: string[] } = {}): Promise<ReconciliationReport> {
  const started = Date.now();
  const scoped = opts.walletIds !== undefined;
  const list = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const ids = opts.walletIds ?? [];
  const walletScope = (col: string): SQL => (scoped ? (ids.length ? sql`${sql.raw(col)} IN (${list(ids)})` : sql`false`) : sql`true`);
  const txnScope: SQL = scoped
    ? ids.length
      ? sql`(t.sender_wallet_id IN (${list(ids)}) OR t.receiver_wallet_id IN (${list(ids)}))`
      : sql`false`
    : sql`true`;

  const checks: Check[] = await Promise.all([
    run(
      'balance_matches_ledger',
      'Wallet balance equals the net of its ledger entries',
      sql`SELECT w.id AS wallet_id, w.balance::text AS balance,
                 COALESCE(SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0)::text AS ledger_net
          FROM wallets w LEFT JOIN ledger_entries le ON le.wallet_id = w.id
          WHERE ${walletScope('w.id')}
          GROUP BY w.id, w.balance
          HAVING w.balance <> COALESCE(SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0)`,
    ),
    run(
      'ledger_chain_unbroken',
      'Each ledger entry starts where the previous one for that wallet ended',
      sql`SELECT wallet_id, id::text AS entry_id, balance_before::text AS balance_before, prev_after::text AS previous_balance_after
          FROM (SELECT le.*, LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY id) AS prev_after
                FROM ledger_entries le WHERE ${walletScope('le.wallet_id')}) x
          WHERE prev_after IS NOT NULL AND balance_before <> prev_after`,
    ),
    run(
      'transactions_balanced',
      'Debits equal credits within every transaction',
      sql`SELECT le.transaction_id,
                 SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END)::text AS imbalance
          FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
          WHERE ${txnScope}
          GROUP BY le.transaction_id
          HAVING SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END) <> 0`,
    ),
    run(
      'successful_transactions_match_ledger',
      'A SUCCESS transaction has exactly one matching DEBIT and one matching CREDIT',
      sql`SELECT t.public_id, t.amount::text AS amount, COUNT(le.id)::int AS ledger_entries
          FROM transactions t LEFT JOIN ledger_entries le ON le.transaction_id = t.id
          WHERE t.status = 'SUCCESS' AND ${txnScope}
          GROUP BY t.id
          HAVING COUNT(le.id) <> 2
              OR SUM(CASE WHEN le.type = 'DEBIT'  AND le.wallet_id = t.sender_wallet_id   AND le.amount = t.amount THEN 1 ELSE 0 END) <> 1
              OR SUM(CASE WHEN le.type = 'CREDIT' AND le.wallet_id = t.receiver_wallet_id AND le.amount = t.amount THEN 1 ELSE 0 END) <> 1`,
    ),
    run(
      'unsuccessful_transactions_moved_no_money',
      'FAILED, CANCELLED and PENDING transactions have no ledger entries (except a failed withdrawal, whose held funds were returned by a linked reversal)',
      sql`SELECT t.public_id, t.status::text AS status, COUNT(le.id)::int AS ledger_entries
          FROM transactions t JOIN ledger_entries le ON le.transaction_id = t.id
          WHERE t.status IN ('FAILED','CANCELLED','PENDING') AND ${txnScope}
            AND NOT (t.type = 'WITHDRAWAL' AND t.status = 'FAILED'
                     AND EXISTS (SELECT 1 FROM transactions r WHERE r.reversal_of_transaction_id = t.id AND r.status = 'SUCCESS'))
          GROUP BY t.id`,
    ),
    run(
      'no_negative_user_wallets',
      'No user wallet has a negative balance',
      sql`SELECT w.id AS wallet_id, w.balance::text AS balance FROM wallets w
          WHERE w.balance < 0 AND NOT w.is_system AND ${walletScope('w.id')}`,
    ),
    run(
      'no_stuck_transactions',
      `No transaction has been PENDING or PROCESSING for more than ${STUCK_AFTER_MINUTES} minutes`,
      sql`SELECT t.public_id, t.status::text AS status, t.created_at::text AS created_at FROM transactions t
          WHERE t.status IN ('PENDING','PROCESSING')
            AND t.created_at < now() - make_interval(mins => ${STUCK_AFTER_MINUTES}) AND ${txnScope}`,
    ),
    ...(scoped
      ? []
      : [
          run(
            'money_is_conserved',
            'All wallet balances (including the system wallet) sum to zero',
            sql`SELECT SUM(balance)::text AS total FROM wallets HAVING SUM(balance) <> 0`,
          ),
          run(
            'ledger_starts_from_zero',
            "Each wallet's first ledger entry starts from a zero balance",
            sql`SELECT wallet_id, first_balance_before::text AS first_balance_before FROM (
                  SELECT DISTINCT ON (wallet_id) wallet_id, balance_before AS first_balance_before
                  FROM ledger_entries ORDER BY wallet_id, id) f
                WHERE first_balance_before <> 0`,
          ),
        ]),
  ]);

  return {
    ok: checks.every((c) => c.ok),
    scope: scoped ? 'wallets' : 'full',
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checks,
  };
}
