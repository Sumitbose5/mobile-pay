# ADR 0006: One function moves money; idempotency and webhooks make it safe to retry

**Status:** accepted (Phase 2)

**Decision.**
1. `applyTransfer()` (`server/src/modules/wallet/ledger.ts`) is the only code that changes a wallet balance. Add money, send money, withdrawals and reversals all call it inside a caller-owned DB transaction.
2. It locks both wallets with `SELECT ... FOR UPDATE` in ascending id order, validates against the locked rows, checks funds, then writes the transaction, both balances and both ledger entries.
3. Retried client requests are handled by the `Idempotency-Key` middleware, backed by a unique `(user, key, endpoint)` index. Retried gateway callbacks are handled by locking the payment order row and checking its status.
4. The gateway webhook is authenticated by HMAC-SHA256 over `"<timestamp>.<raw body>"` with a 5 minute freshness window. The simulator signs and verifies through the same code path.
5. Add money creates an order first and moves no money until the gateway confirms; the credit debits the system clearing wallet so every ledger transaction balances.

**Why.** One audited path means the invariants (non-negative balance, balanced ledger, no deadlocks) are enforced in one place and by the database as well. Idempotency at both edges means neither a client retry nor a duplicate callback can credit twice.

**Consequences.** Amounts cross the API as integer strings. A payment that is captured by the gateway but cannot be credited (wallet frozen, balance cap) marks the order FAILED with a reason; a real deployment needs a refund step for that case. Server errors (5xx) are not stored against an idempotency key so the client may retry.
