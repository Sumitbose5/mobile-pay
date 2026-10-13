# ADR 0008: Prove the books balance, fail safely, and reverse by adding, never editing

**Status:** accepted (Phase 4)

**Decisions.**
1. **Reconciliation** (`modules/reconciliation`) is a set of read-only queries that return the rows that BREAK a rule, so an
   empty result is a pass: balance equals ledger net; each wallet's ledger is an unbroken chain; each transaction's debits
   equal credits; SUCCESS transactions have exactly one matching debit and credit while FAILED/CANCELLED/PENDING have none; no
   negative user wallet; nothing stuck in flight; and (full runs) all balances sum to zero and every wallet's ledger starts
   from zero. Run it with `npm run reconcile` (exit code 1 on violation), `POST /admin/reconciliation/run`, or from a
   scheduled job (Phase 5). Tests can scope it to specific wallets.
2. **`withTransaction()`** wraps every money transaction: `SET LOCAL lock_timeout` (default 5 s, `LOCK_TIMEOUT_MS`) so a held
   lock yields a fast 503 `SERVICE_BUSY` instead of a hung request; bounded retry with jittered backoff on deadlock (40P01) and
   serialization failure (40001); every other error, including business errors, rolls back and propagates. Lock ordering in
   `applyTransfer` already prevents transfer deadlocks; the retry is the safety net for paths added later.
3. **Reversal** posts a new `REVERSAL` transaction linked by `reversal_of_transaction_id`; the original stays SUCCESS. The
   original row is locked and a unique index backs it up, so a transfer can be reversed at most once. It ignores wallet status
   and limits (an operations action) but cannot create money: if the recipient already spent it, it fails with
   `INSUFFICIENT_BALANCE` and writes a CRITICAL audit event for manual handling.
4. **Pool client errors are handled.** A connection killed while checked out of the pool emits `error` on that client; without a
   listener it is an unhandled event that crashes the process. Found by failure injection (`pg_terminate_backend` mid-transfer).

**Failure injection tests** cover: a real two-transaction deadlock being retried to success; a bounded retry budget; a held row
lock producing 503 within the timeout with the same idempotency key usable afterwards; an exception after the money moved;
a database connection killed before COMMIT; and the database refusing a one-sided ledger at COMMIT. In each case no balance
changes and the books still reconcile.

**Not covered here.** Money captured by a gateway that cannot be credited needs a refund flow; reconciliation against the
gateway's own settlement reports is out of scope for the simulator.
