# ADR 0001: Money is integer paise stored as BIGINT

**Status:** accepted

**Decision.** All amounts are integer paise (1 INR = 100 paise). The database column is `bigint`, Drizzle uses `bigint({ mode: "bigint" })`, and services use JS `bigint`. Amounts cross the API as integer strings. Rupees appear only in the UI formatter.

**Why.** Floating point cannot represent 0.1 exactly, so sums drift. Integers are exact. `bigint` avoids the 2^53 limit of JS numbers.

**Consequences.** Never use `number` for money. Drizzle-kit cannot serialize `0n` defaults, so SQL defaults are written as ``sql`0` ``. JSON has no bigint, so API serialization must convert explicitly (decide string vs number before Phase 2).
