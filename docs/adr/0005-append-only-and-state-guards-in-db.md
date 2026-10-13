# ADR 0005: Enforce financial invariants in the database

**Status:** accepted

**Decision.** `db/migrations/0001_db_guards.sql` adds triggers: `ledger_entries` and `audit_logs` reject UPDATE, DELETE and TRUNCATE; transaction status follows PENDING to PROCESSING to SUCCESS or FAILED with immutable terminal states; core transaction fields cannot change; a deferred constraint trigger requires debits to equal credits per transaction at COMMIT.

**Why.** Application bugs and ad hoc SQL cannot be trusted with money. The database is the last line of defence.

**Consequences.** Corrections are new rows (for example a REVERSAL transaction), never edits. Tests in `tests/schema.test.ts` prove each guard.
