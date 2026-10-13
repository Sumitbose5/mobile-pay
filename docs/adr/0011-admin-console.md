# ADR 0011: Admin console: check the database on every request, flag but never block

**Status:** accepted (Phase 7)

**Decisions.**
1. **Admin access is verified against the database on every request** (`requireActiveAdmin`), not from the access token. Tokens are
   verified statelessly and live 15 minutes, so a demoted or suspended administrator would otherwise keep their powers until the
   token expired. The price is one primary-key lookup per admin request, paid only on the admin router. There is no public way to
   become an admin: `npm run admin:create -- <email> "<name>" <password>` is the only path (besides the seed).
2. **Freezing is just a locked update of the wallet row.** Every money path re-checks wallet status under the same row lock, so a
   freeze takes effect immediately even for payments already running: a payment that locked the wallet first completes before the
   freeze, and any payment after it is refused. `frozen_at` uses `clock_timestamp()`, evaluated after the lock is acquired, so it is
   the true moment of the freeze. Administrators and the caller's own account cannot be frozen (no accidental lock-out). The user is
   notified, the cached profile and dashboard statistics are invalidated, and the action is a CRITICAL audit entry with the reason.
3. **Fraud rules flag, they never block.** Velocity (many transfers in a window), large amount, and a large first payment to a new
   payee are evaluated after the transfer commits and only write `SUSPICIOUS_ACTIVITY` audit entries (one velocity alert per window
   per user). A false positive must not cost an honest customer a payment; admins review the flags and can freeze. Thresholds live in
   `system_settings`. Blocking can be added later behind a setting once real false-positive rates are known.
4. **Admins see everything, users see what concerns them.** The admin transaction list includes other people's failed attempts
   (the investigation case), shows platform-wallet counterparties by name, and every transaction opens with its ledger entries,
   reversal links and audit trail. Viewing a user's data is itself audited (`ADMIN_VIEWED_USER`).
5. **Monitoring queries are index-served.** `(created_at, id)` indexes on transactions and audit logs, and `(status|type, created_at, id)`
   on transactions, all declared `DESC NULLS FIRST` so they match the `ORDER BY` exactly. Measured at 400k transactions and 200k audit
   rows: every first page and deep page reads 21-31 index entries in about 0.04 ms. Pagination is keyset throughout.
6. **Statistics are a cached display aggregate** (60 s), including users, wallet totals, today's volumes and failure rate, alerts in the
   last 24 hours and the latest reconciliation result. Admin screens are code-split so ordinary users do not download them.

**Not in scope.** Suspending or deleting users, role changes from the UI, and mutating job queues from the console (the queue board is
read-only because the CSRF check blocks its own action buttons).
