# 0013 — Timers stay in the database; expiry is confirmed before revocation

**Status:** Accepted (timer mechanism is a product decision, 2026-10-25)

## Context

`implementation-plan.md` defers "Workflows versus database-scheduled jobs for each timer" to Phase 6, and Phase 6's work list says to add Cloudflare Workflows "where they improve durability". Decision 0009 schedules time-based changes with `subscriptions.next_evaluation_at`, swept every minute. The sweep clears the column with a compare-and-set and queues a `refresh_subscription` in the same `db.batch()`, so a timer can never be lost between scheduling and running.

The research ([cloudflare-durability.md](../research/cloudflare-durability.md)) found:

- Workflows are generally available. A sleep lasts at most 365 days. Instance IDs cannot be reused while the instance is retained. Nothing documents how a sleeping instance behaves across a deploy.
- Creating a Workflow instance cannot join a D1 batch. A Workflow timer therefore needs the outbox or the sweep to recover a lost `create()`, so it would run beside the sweep rather than replace it.
- An annual plan cancelled just after renewal can take effect more than 365 days later.

The Phase 6 inventory found one real hole in the current design. The reconciliation planner treats `valid_until <= now` as "not desired" (decision 0009). A reconcile that runs after the boundary but before the boundary's refresh has re-read the source revokes access. If the subscription was renewed or reactivated and that webhook was lost or late, ShareRepo revokes a paying subscriber and only restores them after the refresh lands. That is the scenario `timing/stale-workflow-cannot-revoke-renewed`.

## Decision

### Timers

- **The database timer stays the only authority** for grace expiry, effective cancellation and every other subscription boundary. Workflows are not used for timers.
- **Workflows are not adopted in Phase 6.** No job yet has several provider steps that need step-level durability: each job re-reads its inputs and is idempotent, and queue retries cover its failures. A future multi-step repair may use them. That needs its own decision.
- **The sweep is bounded and observable.**
  - Each tick queues at most 100 due evaluations and 100 due reconciles, as now. After an outage the backlog drains in order of due time, oldest first.
  - Each tick writes a heartbeat log line with how many rows it claimed and how many are still due. An alert fires when the heartbeat is missing for 15 minutes or the oldest due row is more than 15 minutes late ([0014](0014-failure-handling-and-alerting.md)).

### Expiry is confirmed before revocation

- **The planner no longer revokes on `valid_until` alone.** An entitlement that is still `active` with `valid_until <= now` is **expiry pending**: the planner does not grant new access for it and does not revoke existing access either. It waits for the subscription's refresh to re-read the source and move the entitlement to `expired`. Only then is the access not desired and revoked.
  - A late sweep still never extends access: an expiry-pending entitlement grants nothing new.
  - The refresh is already queued by the sweep, or by its repair path for active entitlements past `valid_until`.
- **The wait is bounded.** If the entitlement is still active 6 hours after `valid_until` (`EXPIRY_CONFIRMATION_WINDOW`), the planner treats it as not desired and revokes. This covers a source that stays unreadable: a Paddle outage, or an `unauthorized` connection, whose last known facts say the access ended (decision 0011).
- The window is a domain constant with a test, not a creator setting.

### Replay

- The scenario `workflow/replay-is-idempotent` is renamed `timing/sweep-replay-is-idempotent`, because there are no Workflows. It covers the same risk: the same tick, or the same due row, run twice changes nothing the second time.

## Consequences

- Decision 0009's rule "the planner treats `valid_until <= now` as not desired" is amended by this record: after the confirmation window, or once the entitlement is `expired`.
- A subscriber whose renewal webhook was lost keeps access through the boundary. The refresh then finds the renewal and keeps the entitlement active.
- A cancelled subscriber loses access within a sweep tick plus one refresh of the boundary, normally under two minutes. During a long Paddle outage they keep it for up to 6 hours more.
- There is no 365-day limit and no second scheduling mechanism to test.
- If a later job needs step-level durability, Workflows remain available. That decision will cover deploys during sleeps and instance retention.
