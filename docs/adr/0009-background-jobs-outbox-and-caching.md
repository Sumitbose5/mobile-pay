# ADR 0009: Background work runs in a separate worker, fed by a transactional outbox

**Status:** accepted (Phase 5)

**Decisions.**
1. **Separate worker process** (`npm run worker`, `src/worker.ts`) runs the BullMQ workers and the outbox dispatcher. The API only
   enqueues. It can be scaled, restarted and deployed independently, and shuts down gracefully on SIGTERM so in-flight jobs finish.
2. **Transactional outbox.** A business transaction writes an `outbox_events` row in the same commit as the money. The dispatcher
   (`FOR UPDATE SKIP LOCKED`, so any number can run) turns committed rows into queue jobs. An event therefore exists if and only
   if the money moved, and a crash between "enqueue" and "mark done" only causes a harmless repeat.
3. **At-least-once with idempotent consumers.** Job ids derive from the outbox id, and `notifications` has a unique
   `(user_id, dedupe_key)` index, so a redelivered job cannot create a second notification.
4. **Email is a queue job** (`send-email`): 5 attempts with exponential backoff; exhausted jobs stay in BullMQ's failed set
   (the dead-letter set, kept 7 days, visible in the read-only admin queue dashboard). An SMTP outage never delays or fails a
   request and never loses mail. Money emails respect per-user preferences; security emails and reversals always send.
5. **Repeatable jobs** (BullMQ job schedulers, upserted on worker start, so repeated starts register each once): idempotency-key
   cleanup (hourly), payment-order expiry (5 min), refresh-token cleanup (daily 03:00 IST) and ledger reconciliation (daily
   02:00 IST). A failing reconciliation raises one in-app alert and email per active admin per day and a CRITICAL audit entry.
6. **Redis is a cache, never a source of truth for money.** `cached()` is read-through for display data only (profile, monthly
   summary, unread count), degrades to "no cache" if Redis is down, and every write path invalidates what it changed. Balances,
   limits and PIN state used in decisions are always read from PostgreSQL.

**Found by tests.** The idempotency cleanup job failed with a foreign-key violation, because transactions referenced the key rows
that created them. The link is now `ON DELETE SET NULL`: the transaction is permanent and the key is ephemeral.

**Consequences.** Notifications are eventually consistent (typically well under a second, up to the poll interval when idle). The
API and worker must share the same `REDIS_URL` and `QUEUE_PREFIX`. A single-process deployment can run both, but production should
run the worker separately.
