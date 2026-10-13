# ADR 0003: Transactional outbox for notifications and emails

**Status:** accepted

**Decision.** Domain events (money sent, money received, failure) are inserted into `outbox_events` inside the same DB transaction as the money movement. A dispatcher job reads pending rows with `FOR UPDATE SKIP LOCKED` and enqueues BullMQ jobs.

**Why.** Enqueuing directly can send a notification for a transaction that later rolls back, or lose one if the process dies after commit. The outbox makes the event exist if and only if the money moved.

**Consequences.** Delivery is at-least-once, so workers must be idempotent.
