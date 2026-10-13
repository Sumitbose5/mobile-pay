# ADR 0007: Transaction history is read per side, keyset-paginated, and shows receivers only completed payments

**Status:** accepted (Phase 3)

**Decision.**
1. History runs two queries, one for transactions the user sent and one for those they received, each ordered
   `created_at DESC, id DESC` with its own `LIMIT`, then merges them in memory. Pagination is keyset (a cursor of
   `created_at` + `id`), never OFFSET. The timestamp travels as text so microsecond precision survives the round trip.
2. The two history indexes are `(wallet_id, created_at DESC NULLS FIRST, id DESC NULLS FIRST)`. The null ordering
   matters: a plain `DESC` sort is NULLS FIRST, and an index declared NULLS LAST cannot serve it.
3. Visibility: you see everything you sent or initiated (including FAILED attempts), but as a receiver only transactions
   with status SUCCESS. A failed or cancelled attempt to pay you is never shown to you. Someone else's transaction
   returns 404, not 403, so ids cannot be probed.
4. Failed business refusals (insufficient balance, limits, frozen wallet) are recorded as FAILED transactions in a
   separate write after the money transaction rolls back, so history explains what happened without any balance change.
   Wrong PINs and validation errors are not recorded.

**Measured** (400k transactions, one wallet party to 200k of them): the original single `sender = me OR receiver = me`
query read all 200,000 rows and sorted them (about 100 ms, growing with history). The per-side query with the matching
index reads 21 index entries (about 0.4 ms), including deep pages.

**Why.** A wallet's history only grows. The query cost must depend on the page size, not on the size of the history.
