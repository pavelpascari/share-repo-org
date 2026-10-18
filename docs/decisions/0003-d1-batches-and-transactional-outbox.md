# 0003 — D1 atomicity through batches and a transactional outbox

**Status:** Proposed

## Context

`architecture.md` requires event receipt, resulting state changes, job intent, and audit facts to commit atomically when they belong to one decision. D1 does not offer interactive transactions (`BEGIN … COMMIT` across awaited application code). It does execute a `batch()` of prepared statements atomically. Cloudflare Queues cannot take part in a D1 commit.

## Decision

- Repository methods that must be atomic are written as a single statement batch (via Drizzle `db.batch()` or the D1 binding). Reads needed to build the batch happen first; the batch is guarded with conditional statements, unique constraints, or version columns so that a concurrent writer causes a detectable no-op or conflict instead of a lost update.
- Work handoff goes through an `outbox` table written in the same batch as the state change. A drainer in the `jobs` Worker (triggered by the web request via a best-effort queue send, and by cron as a safety net) publishes outbox rows to Queues and marks them sent. Queue messages carry an idempotency key and identifiers only, never authoritative state.
- Audit events are written in the same batch as the change they explain.

## Consequences

- Application services cannot hold a transaction open across a provider call. Provider mutations always happen in the jobs Worker after a committed intent, followed by a separate observe-and-persist batch.
- Tests must cover crash points between batches (see `testing-strategy.md`, convergence model).
- The outbox can deliver more than once; consumers are already required to be idempotent.
