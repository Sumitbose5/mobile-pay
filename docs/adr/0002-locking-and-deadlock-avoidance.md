# ADR 0002: Row-level locking in deterministic order

**Status:** accepted

**Decision.** Every money movement runs in one PostgreSQL transaction at READ COMMITTED and locks the involved wallets with `SELECT ... FOR UPDATE`, always in ascending wallet id order, then re-checks status and balance under the lock.

**Why.** The lock serialises concurrent spends on one wallet, so the second request sees the post-debit balance. Fixed lock order means A to B and B to A at the same moment cannot deadlock.

**Safety net.** `CHECK (balance >= 0)` rejects an overdraft even if application code is wrong. `tests/schema.test.ts` proves FOR UPDATE blocks a second transaction.

**Consequences.** Transactions must stay short and make no network calls while holding locks. The Neon HTTP driver cannot run interactive transactions, so the app uses `pg` over TCP.
