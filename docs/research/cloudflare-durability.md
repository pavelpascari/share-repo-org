# Cloudflare durability, timing and operations for Phase 6

Research date: 2026-10-25. Primary sources only: developers.cloudflare.com (product docs, the changelog, and the Markdown copy each page serves at `<url>/index.md`), plus the type declarations shipped in the pinned `@cloudflare/vitest-plugin@1.4.4` and `@cloudflare/workers-types@5.20261018.1`. Items that no primary source confirms are marked **UNCONFIRMED**.

Pinned versions this was checked against ([0001](../decisions/0001-stack-versions.md)): Wrangler **4.151.1**, `@cloudflare/vite-plugin` **1.64.0**, `@cloudflare/vitest-plugin` **1.4.4** (the renamed `@cloudflare/vitest-pool-workers`; rename announced 2026-08-19), Vitest 4.1.12, compatibility date `2026-10-01`. Both Workers already set `observability.enabled: true` and `upload_source_maps: true`. The jobs Worker consumes `sharerepo-events-{dev,prod}` with `max_batch_size: 10`, `max_retries: 5` and **no dead-letter queue**, and runs crons `* * * * *` (outbox drain and the `next_evaluation_at` sweep), `0 * * * *` and `17 3 * * *`.

Every version-gated feature below is satisfied by these pins: Workflows in `exports` (Wrangler ≥ 4.139), `ctx.exports` Workflows (Wrangler ≥ 4.142, vite plugin ≥ 1.61, vitest plugin ≥ 1.3), `createBatch` object form (≥ 4.148), the Analytics SQL binding (≥ 4.145), Issues (≥ 4.134) and `wrangler workflows … --local` (≥ 4.79).

## Summary: decisions and implications

| # | Finding | Implication for ShareRepo |
|---|---|---|
| 1 | Workflows has been GA since 2025-04-07. `step.sleep`/`sleepUntil` last at most **365 days**. Sleeping instances do not count against concurrency. Step and storage billing started no earlier than 2026-08-10. | The platform can technically hold one durable timer per subscription. Cost is not a factor at private-beta scale. |
| 2 | Instance IDs are unique per Workflow **for as long as the instance is retained**. `create()` with a live ID **throws**. `createBatch` reports code `10405` instead of throwing. IDs match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` and are at most 100 characters, so **colons are not allowed**. | A deterministic ID such as `sub_<id>_<boundaryEpoch>` makes "schedule this boundary" idempotent. Treat "already exists" as success. Re-scheduling needs a new boundary ID; it cannot reuse one. |
| 3 | Starting a Workflow is a call to a separate service, outside the D1 batch. The docs do not say whether a resumed instance runs the code that was current when it started or the latest deploy (**UNCONFIRMED**). Step names are the replay cache key. | Workflows does not remove the dual-write problem: the outbox or the sweep still has to cover a lost `create()`. Deploys have to keep step names stable for in-flight instances. |
| 4 | Retention of finished instances is inconsistent in the docs: the limits page says 30 days on Paid, while the 2026-09-10 changelog says **7 days** for Workflows created after that date (30-day maximum). | Instance history is not an audit trail. Set `default_retention` explicitly. Keep audit events in D1, as decision 0007 already requires. |
| 5 | Queues: without a DLQ, a message that reaches `max_retries` is **deleted permanently**. A DLQ is one config key and is auto-created. With no consumer, DLQ messages persist for 4 days. `Queue.metrics()` (2026-04-28) returns live `backlogCount` and `oldestMessageTimestamp`. | Add `dead_letter_queue` now. Consume it in the jobs Worker into a durable D1 "failed work" row with an audit event, so failures are "visible, actionable, and correlated" (Phase 6 acceptance). |
| 6 | No Platform Notification type covers Workers errors, Queue backlog, DLQ depth or Workflow failures. The new alerting paths are **Monitors (beta, 2026-10-02)**, which run SQL API queries on a schedule (≥ 1 min) with email/webhook destinations, and **Workers Issues**, which groups errors and has automations. | The smallest setup: Issues on both Workers, plus two or three Monitors over `logs.workersLogs` (errors, a cron heartbeat as a dead-man's switch, a DLQ marker). Section 4 has the details. |
| 7 | D1 Time Travel is always on: restore to any minute in the last **30 days** (Paid). A restore is **destructive and in place**; clone or fork is "in the future". `wrangler d1 migrations apply` captures a backup and rolls back the failing migration. Undelete only works within **7 days** (2026-10-23). | A restore drill cannot target a copy through Time Travel. Rehearse with `d1 export` → import into a scratch database, and rehearse an in-place restore on the dev database. Keep migrations expand/contract, because rollback is per file, not per deploy. |
| 8 | `wrangler secret put` **creates and deploys a new version immediately**. Secrets are per Worker. Secrets Store is still **open beta** (100 secrets, one store per account). | Rotating `CREDENTIAL_KEYS`/`CLAIM_SIGNING_KEY` is two independent deploys (web, jobs), so the key ring must tolerate a window where the Workers disagree. Stay on Worker secrets. |
| 9 | Test APIs in plugin 1.4.4: `createMessageBatch`/`getQueueResult` (with `attempts`), `introspectWorkflowInstance` with `disableSleeps`, `disableRetryDelays`, `mockStepResult`, `mockStepError`, `forceStepTimeout`, `mockEvent`. `fetchMock` is gone; use MSW. Nothing simulates a crash between D1 writes. | Fault injection for crashes between writes has to come from our own seams (injected repository or D1 wrapper), not the platform. Section 6 lists the techniques. |

## 1. Cloudflare Workflows

### Status and limits (Workers Paid)

- **GA since 2025-04-07.** Python Workflows is in beta; JavaScript/TypeScript is GA.
- **Steps per instance:** 10,000 by default, configurable to 25,000 with `limits.steps` on the binding. `step.sleep`/`sleepUntil` do not count toward this limit.
- **Sleep:** the maximum `step.sleep` duration is **365 days**. `sleepUntil(name, Date | epochMs)` exists. The docs state no maximum horizon for `sleepUntil` separately; assume the same 365 days (**UNCONFIRMED**).
- **`waitForEvent`:** the timeout defaults to 24 h and ranges from 1 s to 365 days. Events sent before the instance reaches `waitForEvent` are **buffered**. `sendEvent` throws if the instance is not running or has errored.
- **Concurrency:** the table says 50,000 running instances per account. The prose on the same page still says 10,000. The 2026-04-15 changelog confirms **50,000**. `waiting` instances (sleeping, retry backoff, waiting for an event) **do not count**. Resuming from sleep takes priority over newly queued instances.
- **Creation rate:** 300/s per account and 100/s per Workflow. Exceeding it returns HTTP 429. Up to 2,000,000 queued instances.
- **State:** step result ≤ 1 MiB (non-stream), event payload ≤ 1 MiB, and ≤ 1 GB persisted per instance.
- **CPU and wall time:** 30 s CPU per step by default, configurable to 5 min with `limits.cpu_ms`. Wall time per step is unlimited. "Rules of Workflows" advises step timeouts of ≤ 30 min.
- **Subrequests:** 10,000 per instance by default, configurable up to 10 million.
- **Retention of finished instances:** see "Retention" below.

### Steps, retries and failure

- `step.do(name, config?, callback, rollbackOptions?)`. The **default** config is `retries: { limit: 5, delay: 10000, backoff: "exponential" }, timeout: "10 minutes"`. The step timeout applies per attempt. `limit` can be up to 10,000 retries per step.
- `retries.delay` can be a function `({ ctx, error }) => duration` (2026-07-09), for example to honour `Retry-After`. `ctx.attempt` is 1-indexed (2026-03-06).
- Throwing `NonRetryableError` stops retries for that step. Any error reaching `run()` puts the instance into `errored`.
- **Rollback handlers** (saga compensation) exist since 2026-06-05. They run in reverse order when the instance fails, and with `terminate({ rollback: true })`.
- **Rules of Workflows** (last updated 2026-10-15):
  - Steps may be retried, so make them idempotent.
  - Do not rely on in-memory state outside steps: the engine may hibernate.
  - Code outside `step.do` "might be repeated more than once".
  - Name steps deterministically: names are the cache key.
  - Branch only on the event payload or on step outputs.
  - Wrap `Promise.race` in a single step.
  - `await` every step.

Sources:
- https://developers.cloudflare.com/workflows/reference/limits/ (updated 2026-09-21)
- https://developers.cloudflare.com/workflows/build/workers-api/ (updated 2026-10-12)
- https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ (updated 2026-09-24)
- https://developers.cloudflare.com/workflows/build/events-and-parameters/
- https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- https://developers.cloudflare.com/workflows/reference/changelog/
- https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/
- https://developers.cloudflare.com/changelog/post/2026-04-15-workflows-limits-raised/
- https://developers.cloudflare.com/changelog/post/2026-07-09-dynamic-retry-delays/
- https://developers.cloudflare.com/changelog/post/2026-06-05-saga-rollbacks/

### Instance IDs and idempotent creation

- `create({ id?, params?, retention? })`. The ID is up to 100 characters and matches `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`.
- `create()` "throws an error if the provided ID is already used by an existing instance that has not yet passed its retention limit. To re-run a workflow with the same ID, you can `restart` the existing instance."
- `createBatch({ instances: [...] })` creates up to 100 instances at once and **does not throw** on duplicates. It reports `10405` ("An instance with this ID already exists") or `10415` (a duplicate within the batch) in `errors[]`. The old array form is deprecated; it silently skipped duplicates.
- **ID reuse after completion:** reuse is possible only once the old instance has passed retention or been deleted (`instance.delete()` or `deleteBatch`, 2026-09-17). Cloudflare's guidance is that "instance IDs are unique", and it suggests composite IDs plus a mapping table in D1.
- **Instance control:**
  - `pause()`, `resume()`, `terminate({ rollback? })`.
  - `restart({ from?: { name, count?, type? } })` reuses cached results of earlier steps.
  - `delete()` stops execution without running rollbacks.
  - `status()` returns `queued | running | paused | errored | terminated | complete | waiting | waitingForPause | unknown`.
  - `subscribe()` streams instance events (2026-09-15).
  - `terminate()` throws if the instance is already errored, terminated or complete.

### Retention

- The limits and pricing pages say finished instance state is retained **30 days on Paid** (3 days Free) by default.
- The **2026-09-10 changelog** says Workflows *created on or after* 2026-09-10 on Paid default to **7 days**. The maximum stays 30 days, and existing Workflows are unchanged.
- The two sources disagree for new Workflows. Set `default_retention: { success_retention, error_retention }` on the defining Worker explicitly, or pass `retention` per instance. `default_retention` cannot be combined with `script_name`.
- Retained state is billed as storage.

### Cross-Worker binding, `exports` and schedules

- **Cross-script binding:** a Worker binds a Workflow defined in another Worker with `workflows: [{ name, binding, class_name, script_name }]`.
- **`exports`:** since 2026-09-24 a Worker can declare `exports: { MyWorkflow: { type: "workflow", name, schedules?, limits?, default_retention? } }`. It then calls the Workflow through `ctx.exports.MyWorkflow` (2026-09-27) without a binding.
- **Name scope:** Workflow names are unique per **account**. A dev and a production Workflow therefore need distinct names per environment, as our queue names already are.
- **`schedules`:** since 2026-06-02 a Workflow binding can carry cron `schedules` (100 per account). Each firing creates an instance with `event.schedule = { cron, scheduledTime }`. On Paid, a scheduled instance gets one hour per firing outside the concurrency limit.
- **Remote bindings:** Workflows are not supported as remote bindings or with `wrangler dev --remote`.

### Pricing (Workers Paid)

- Requests and CPU are billed like Workers.
- **Steps:** 500,000 included per month, then $0.80 per 100,000. The 2026-07-07 changelog counts sleeping and waiting for events as steps. The limits page excludes `sleep` from the *step limit*, which is a different thing.
- **Storage:** 1 GB-month included, then $0.20/GB-month.
- Step and storage billing started no earlier than **2026-08-10**.
- Idle time (sleep, waiting on I/O) costs no CPU.
- For scale: one timer per subscription is a handful of steps per instance, so even 10,000 subscribers stay inside the included steps.

Sources:
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/
- https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/
- https://developers.cloudflare.com/changelog/post/2026-10-08-create-batch-object-form/
- https://developers.cloudflare.com/changelog/post/2026-09-17-instance-delete/
- https://developers.cloudflare.com/changelog/post/2026-09-24-workflow-exports/
- https://developers.cloudflare.com/changelog/post/2026-09-27-workflow-ctx-exports/
- https://developers.cloudflare.com/changelog/post/2026-06-02-cron-workflows/
- https://developers.cloudflare.com/workflows/build/trigger-workflows/ (updated 2026-10-15)

### Local development and tests

- **`wrangler dev`:** runs an emulated engine.
  - Since 2026-03-23 it supports `pause`/`resume`/`restart`/`terminate`.
  - All `wrangler workflows` commands accept `--local` (2026-04-01).
  - Local Explorer at `/cdn-cgi/local/explorer` lists instances and step history.
- **Vitest plugin** (`cloudflare:test`, verified against the 1.4.4 type declarations):
  - `introspectWorkflowInstance(binding, id)` and `introspectWorkflow(binding)` (with `modifyAll`, `get`).
  - **`WorkflowInstanceModifier`** provides:
    - `disableSleeps(steps?)`
    - `disableRetryDelays(steps?)`
    - `mockStepResult(step, result)`
    - `mockStepError(step, error, times?)`
    - `forceStepTimeout(step, times?)`
    - `mockEvent({ type, payload })`
    - `forceEventTimeout(step)`
  - The introspector exposes `waitForStepResult`, `waitForStatus`, `getOutput`, `getError`, and `dispose`/`Symbol.asyncDispose`.
  - **Dispose every introspector**, or state leaks across tests in the same file.
  - A Workflow declared only in `exports` needs a test-only binding under `miniflare.workflows`.
- **Limit:** sleeps can be *disabled* but not advanced to a chosen instant. To test "renewed while sleeping", the post-sleep reload must be a step whose input or D1 state the test controls. Mocking `Date` is not enough.
- **Retry counts:** whether `mockStepError(…, times)` exercises the same retry counter as production is **UNCONFIRMED**; it is emulated.

Sources:
- https://developers.cloudflare.com/workflows/build/local-development/ (updated 2026-10-12)
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#workflows (updated 2026-10-10)
- https://developers.cloudflare.com/changelog/post/2026-04-01-wrangler-workflows-local/

### Observability for Workflows

- **GraphQL:** the `workflowsAdaptiveGroups` dataset, with `eventType` values `WORKFLOW_QUEUED`, `WORKFLOW_START`, `WORKFLOW_SUCCESS`, `WORKFLOW_FAILURE`, `WORKFLOW_TERMINATED`, `STEP_START`, `STEP_SUCCESS` and `STEP_FAILURE`.
- **Event subscriptions:** Queues can receive `cf.workflows.workflow.instance.{queued,started,paused,errored,terminated,completed}`.
- Sources:
  - https://developers.cloudflare.com/workflows/observability/metrics-analytics/
  - https://developers.cloudflare.com/workflows/reference/event-subscriptions/

### Code changes while an instance sleeps (**UNCONFIRMED**)

- No Cloudflare page states whether a resumed instance runs the code version it started on or the currently deployed one. Event-subscription payloads carry a `versionId`.
- A third-party comparison claims there is no version pinning: resumed instances run the latest deploy, and replay is matched by step name. Not verified against a primary source.
- Design as if the latest code resumes old instances. Never rename or reorder steps before a pending sleep, and version the step names when the flow changes.

### Workflows vs. the `next_evaluation_at` cron sweep

Neither Cloudflare nor any practitioner source I found addresses subscription-boundary timers specifically. Cloudflare presents Workflows as fit for "lifecycle emails" and "wait 30 days, then continue". The following analysis is mine, built on the facts above.

**What the current sweep already gives ShareRepo**

- D1 is the single source of truth. The boundary is written in the **same `db.batch()`** as the subscription change, so there is no dual write.
- A compare-and-clear guard (`UPDATE … SET next_evaluation_at = NULL WHERE … AND next_evaluation_at = <read value>`) already makes a stale wake-up harmless and lets a renewal reschedule atomically. That is the Phase 6 criterion "A stale delayed workflow cannot revoke a renewed subscriber".
- Latency is ≤ 1 minute after the boundary. That is fine for a grace period measured in days, with a 30-day maximum.
- It is one indexed query per minute and has no per-subscription infrastructure.

**What Workflows would add**

- Per-timer step retries with backoff, without hand-written retry bookkeeping.
- Per-instance visibility in the dashboard.
- No dependence on a minutely cron firing.

**Failure modes Workflows introduces**

1. **Dual write.** The D1 batch commits, then `create()` fails or the isolate dies, and the timer never exists. Fixing that needs the outbox or a sweep anyway, which leaves two mechanisms to keep consistent.
2. **Rescheduling.** A renewal or a changed `scheduled_change.effective_at` needs a new instance with a new ID. Terminating the old one is optional, but only if the woken instance re-reads D1 and no-ops, which is the same guard the sweep already has.
3. **The 365-day ceiling.** An annual plan cancelled right after renewal can have an effective date of about 365 or 366 days, which can exceed the maximum sleep. The workflow would need a clamp-and-loop.
4. **Code version on resume** is undocumented (above). A deploy that renames steps can corrupt in-flight timers.
5. **History retention** is 7 or 30 days, so Workflows history cannot serve as the record of why access ended.
6. **Fewer test seams.** Tests can disable sleeps but cannot advance them to a chosen instant, so timing tests become less direct than injecting `now` into the sweep.

**Failure modes of the sweep**

1. **It can stop silently**, for example after a deploy that drops the cron, or while cron changes take up to **15 min to propagate**. Mitigation: the existing hourly heartbeat plus a dead-man's-switch alert (section 4).
2. **Backlog after an outage.** The cron CPU limit is 30 s for intervals under 1 hour, and wall time is 15 min. Mitigation: bounded batches, as `partition scheduled reconciliation` in the plan already asks.
3. **Cron retry semantics are not documented.** `ScheduledController.noRetry()` exists, which suggests failed scheduled events can be retried (**UNCONFIRMED**). The sweep must be idempotent either way, and it is.

**Conclusion for planning (to record as an ADR)**

- For grace-period expiry and effective cancellation, the existing sweep is the smaller sufficient system and already meets the stale-timer criterion. Workflows would add a second source of truth without removing the sweep.
- Workflows earns its place where a job is **multi-step with external side effects and per-step retry**. Examples: a partitioned full reconciliation (one instance per connection, a step per page of provider calls, `delay` honouring `Retry-After`), or a repair that must call GitHub then write D1 then emit audit events.
- If Workflows is adopted for any timer, keep `next_evaluation_at` as the authority and let the workflow only *nudge* the same evaluation function.

## 2. Cloudflare Queues

- **Dead-letter queue:**
  - Set `dead_letter_queue: "<name>"` on the consumer. A missing queue is auto-created in the same jurisdiction.
  - **Without a DLQ, messages that reach `max_retries` "are deleted permanently".**
  - DLQ messages with no consumer persist for 4 days.
  - A DLQ is an ordinary queue: give it its own consumer, and producer bindings if needed.
- **Retries:**
  - `max_retries` defaults to 3, with a platform maximum of **100**.
  - A throw from the handler retries the **whole batch** except explicitly `ack()`ed messages.
  - `msg.retry({ delaySeconds })` and `batch.retryAll({ delaySeconds })` retry explicitly. The first call on a message wins: `ack` then `retry` keeps the ack.
  - `retry_delay` (seconds) on the consumer sets the default delay for retries.
  - `delaySeconds` has a **maximum of 24 hours**, on send and on retry. `delivery_delay` sets a producer-level default.
- **Attempts:** `message.attempts` "Starts at 1". Exponential backoff is built from it by hand.
- **Batching:** `max_batch_size` defaults to 10 (1–100). `max_batch_timeout` defaults to 5 s (0–60 s).
- **Consumer concurrency:**
  - Autoscales up to **250** concurrent invocations by default. Cloudflare recommends leaving `max_concurrency` unset.
  - Explicit `retry()` does not count as a failure for autoscaling. A throwing handler does.
  - Wall time is 15 min per invocation; CPU is 30 s by default, configurable to 5 min.
- **Retention:** 4 days by default on Paid, configurable to 14 days (24 h on Free). The backlog limit is 25 GB per queue. Messages are ≤ 128 KB.
- **Metrics:**
  - `env.QUEUE.metrics()` returns `{ backlogCount, backlogBytes, oldestMessageTimestamp }` (2026-04-28). `send()` and `sendBatch()` return the same metrics. Present in our generated types and in Miniflare 5.20261012.
  - GraphQL `queueMessageOperationsAdaptiveGroups` has an `outcome` dimension of `success | dlq | fail` on `DeleteMessage`. `queuesBacklogAdaptiveGroups` reports backlog.
  - Whether the SQL API (and therefore Monitors) exposes a Queues dataset is **UNCONFIRMED**; the catalog must be introspected per account.
- **Pricing:**
  - $0.40 per million operations after 1 million per month included. A delivery is about 3 operations (write, read, delete), and each retry is an extra read.
  - Queues has been available on Workers Free since 2026-02-04.
- **Pause and purge:** API since 2025-03-25 (title only, not read).

Sources:
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ (updated 2026-10-12)
- https://developers.cloudflare.com/queues/configuration/batching-retries/
- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://developers.cloudflare.com/queues/configuration/consumer-concurrency/
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/queues/observability/metrics/
- https://developers.cloudflare.com/changelog/post/2026-04-28-improved-queues-metrics/

## 3. D1

- **Time Travel** is always on and free.
  - It restores to any minute within **30 days** (Paid; 7 days on Free) by timestamp or bookmark: `wrangler d1 time-travel info|restore <DB> --timestamp=… | --bookmark=…`.
  - A restore **overwrites the database in place** and cancels in-flight queries.
  - It prints the previous bookmark so the restore can be undone.
  - Limit: **10 restores per 10 minutes** per database.
  - **No clone or fork yet.** Only `version: production` databases support it (`wrangler d1 info`).
- **Export and import:**
  - Export with `wrangler d1 export <DB> --remote --output=… [--table] [--no-data|--no-schema]`.
  - Import with `wrangler d1 execute <DB> --remote --file=…`, up to 5 GB.
  - **A running export blocks other database requests.** Export does not support virtual tables (FTS5).
  - For retention beyond 30 days, Cloudflare documents a Workflow that exports D1 to R2 through the REST API (https://developers.cloudflare.com/workflows/examples/backup-d1/).
- **Undelete:** since 2026-10-23, the undelete API only works for databases deleted within the last **7 days**.
- **Migrations (`wrangler d1 migrations apply`):**
  - Prompts for confirmation, skipping the prompt in CI.
  - "After applying, a backup will be captured."
  - "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied."
  - So each file is atomic, but a multi-file deploy is not.
  - Applied files are tracked in `d1_migrations`, or the table named by `migrations_table`. `migrations_pattern` exists for nested layouts.
  - Use `PRAGMA defer_foreign_keys = true` for changes that would temporarily violate foreign keys.
  - Use the database **name**, not the binding, to avoid targeting the wrong database.
- **Limits (Paid):**
  - **10 GB** per database (not raisable) and 1 TB per account.
  - 30 s maximum query duration, 100 bound parameters, 100 KB statements, 2 MB per row.
  - 1,000 queries per invocation; a `batch()` counts as one.
  - Each database is single-threaded. Large `UPDATE`/`DELETE` jobs must be chunked.
- **Read replication:**
  - Public beta since 2025-04-10, through the Sessions API.
  - The current page (updated 2026-08-10) no longer says "beta", but I found no GA announcement (**UNCONFIRMED**).
  - Not needed for ShareRepo.

Sources:
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/
- https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply
- https://developers.cloudflare.com/d1/reference/migrations/ (updated 2026-06-08)
- https://developers.cloudflare.com/d1/platform/limits/ (updated 2026-10-24)
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://developers.cloudflare.com/changelog/post/2026-10-23-undelete-seven-day-window/

## 4. Observability and alerting

### Logs and traces

- **Workers Logs:**
  - Configured with `observability: { enabled, head_sampling_rate (0–1, default 1), logs.invocation_logs }`. It is on by default for new Workers.
  - Retention is **7 days on Paid** (3 days on Free). Logs are ≤ 256 KB each, and the account limit is 5 billion per day.
  - Pricing: 20 million events per month included, then $0.60 per million.
  - **From 2026-12-01**, all logs and traces move to unified Observability pricing: Paid includes 50 GB ingestion and 10 GB-month storage per cycle, then $0.25/GB and $0.10/GB-month. "Queries, dashboards, alerts, and analytics do not incur additional charge."
  - Log JSON objects: fields are indexed automatically.
- **Workers Logpush** (Workers Trace Events):
  - Enabled per Worker with `logpush: true` plus a Logpush job.
  - The `logs` and `exceptions` fields are truncated at 16,384 characters combined.
  - It keeps request-based pricing. Logpush in general moved to usage-based pricing on all plans on 2026-09-30.
  - Cloudflare now recommends **OpenTelemetry export** for new integrations.
- **Tail Workers:** Paid only and billed by CPU. Cloudflare calls them "the advanced-mode option" and points to OTel export instead.
- **Workers Analytics Engine:**
  - Custom metrics via `writeDataPoint`, retained **3 months**.
  - Billing has not started; listed prices are 10 million writes and 1 million reads per month included.
  - Queryable through the SQL API as `events.analyticsEngine.<dataset>`, so **Monitors can alert on it**.

### Alerting options

- **Platform Notifications:** I checked the full list. It has **no** type for Workers errors, Queues or Workflows. Its "Usage Based Billing" alerts need a Professional plan or higher.
- **Monitors (beta, 2026-10-02):**
  - Evaluate one SQL API query on a schedule (most datasets allow a 1-minute interval).
  - Detection: threshold (`<`, `>`, `<=`, `>=`, `==` or `!=`), anomaly (needs 30 min of history) or SLO.
  - Destinations: email (≤ 20 recipients), webhook (all plans since 2026-10-02) or PagerDuty (needs a Business zone).
  - The repeat-notification interval defaults to 1 h.
  - Datasets include `logs.workersLogs`, `events.analyticsEngine.*` and `states.d1Storage`.
  - Whether Monitors are included on Workers Paid at no cost is implied by "alerts … do not incur additional charge" after 2026-12-01; current beta pricing is not stated (**UNCONFIRMED**).
- **Workers Issues:**
  - Enabled with `observability.issues.enabled: true`. If Wrangler deploys omit it, "the next deployment turns off Issues".
  - It groups uncaught exceptions, failed invocations, 5xx responses and `console.error` calls into issues, with stack traces mapped through source maps.
  - **Automations** fire on an occurrence threshold or on recurrence after inactivity, and go to a webhook, chat, incident tool or coding agent. Email is not listed as an Issues destination.
  - Plan availability and beta status are not stated on the page (**UNCONFIRMED**).
- **Alerting on DLQ count:** no built-in alert exists. The workable options:
  1. A DLQ consumer that records each dead message (D1 row plus audit plus one `console.error` with a stable marker such as `"event":"job.dead_lettered"`). Issues or a Monitor on `logs.workersLogs` then fires.
  2. The minutely cron reads `env.DLQ.metrics()` (this needs a producer binding to the DLQ) and logs an error when `backlogCount > 0`.
  3. Poll GraphQL `outcome: dlq` from outside.

  Option 1 is also the one that satisfies "correlated to affected access".

### Smallest sufficient setup for one operator

1. **Issues** on both Workers, with an automation (occurrence threshold of 1, then recurrence after inactivity) sent to one chat or webhook destination the operator watches.
2. **Monitor A** (threshold > 0, 5-minute window): count of `logs.workersLogs` rows at error level, or carrying our `"severity":"critical"` field, for `sharerepo-*-production`. Email destination.
3. **Monitor B, the dead-man's switch** (threshold `< 1` over 15 minutes): count of the sweep's `"event":"sweep.completed"` log lines. It catches a cron that stopped firing or a jobs Worker that fails before logging.
4. **DLQ** consumed into D1, with an operator page listing unresolved failures (Phase 6 runbook). Its marker log line feeds Monitor A.

Analytics Engine, Logpush and Tail Workers are not needed at this size.

Sources:
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (updated 2026-10-12)
- https://developers.cloudflare.com/observability/pricing/ (updated 2026-10-15)
- https://developers.cloudflare.com/workers/observability/logs/logpush/
- https://developers.cloudflare.com/changelog/post/2026-09-30-logpush-usage-based-pricing/
- https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- https://developers.cloudflare.com/analytics/analytics-engine/
- https://developers.cloudflare.com/analytics/analytics-engine/limits/
- https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- https://developers.cloudflare.com/notifications/notification-available/
- https://developers.cloudflare.com/notifications/monitors/ (updated 2026-10-21)
- https://developers.cloudflare.com/changelog/post/2026-10-02-monitors/
- https://developers.cloudflare.com/changelog/post/2026-10-02-destination-enhancements/
- https://developers.cloudflare.com/analytics/sql-api/
- https://developers.cloudflare.com/analytics/sql-api/datasets/
- https://developers.cloudflare.com/workers/observability/issues/
- https://developers.cloudflare.com/workers/observability/issues/automations/

## 5. Secrets rotation

- **Worker secrets:**
  - "`wrangler secret put` creates a new version of the Worker and deploys it immediately." The same applies to `secret delete`.
  - `wrangler versions secret put` only creates a version, for gradual deployments.
  - `wrangler deploy --secrets-file` uploads code and secrets together. Secrets missing from the file are kept.
  - `secrets.required` in Wrangler config (2026-03-25, already used in both of our configs) makes `deploy` and `versions upload` fail when a secret is missing.
  - A bulk secrets API endpoint exists (2026-06-03; title only, not read).
- **Secrets Store:**
  - Still **open beta**: one store and 100 secrets per account, values ≤ 65,536 bytes.
  - Account-level, so one value can be shared by both Workers.
  - Read with `await env.X.get()`. Local development uses separate local secrets.
  - Whether a value update reaches running Workers without a redeploy is **UNCONFIRMED**.
  - The vitest plugin has `adminSecretsStore()` for seeding in tests.

Sources:
- https://developers.cloudflare.com/workers/configuration/secrets/ (updated 2026-10-15)
- https://developers.cloudflare.com/changelog/post/2026-03-24-secrets-config-property/
- https://developers.cloudflare.com/secrets-store/
- https://developers.cloudflare.com/secrets-store/integrations/workers/
- https://developers.cloudflare.com/secrets-store/manage-secrets/

## 6. Fault injection with `@cloudflare/vitest-plugin` 1.4.4

| Fault | Platform support | Technique |
|---|---|---|
| Duplicate queue delivery | `createMessageBatch(queue, [{ id, timestamp, attempts, body }])` + `getQueueResult(batch, ctx)` returns `{ outcome, ackAll, retryBatch, explicitAcks, retryMessages[{ msgId, delaySeconds }] }` | Deliver the same body twice (same and different `id`), and with `attempts > 1`. Assert one effect, one audit event, and the right `retry({ delaySeconds })`. |
| Exhausted retries / DLQ | None. Miniflare's retry-to-DLQ loop is not exposed as a helper. | Unit-test the DLQ consumer directly with `createMessageBatch` on the DLQ name. Whether Miniflare moves messages to a configured DLQ after `max_retries` locally is **UNCONFIRMED**; check it once in `wrangler dev`. |
| Workflow step failure, timeout, retry | `mockStepError(step, err, times)`, `forceStepTimeout(step, times)`, `disableRetryDelays()` | Assert replay idempotency: run with N failures, then success, and check a single side effect. |
| Workflow sleep, stale wake-up | `disableSleeps()`, `mockStepResult()` | Mutate D1 (renewal) before the post-sleep reload step runs. Assert a no-op. |
| Crash between D1 writes | **None.** `db.batch()` is atomic ([0003](../decisions/0003-d1-batches-and-transactional-outbox.md)). | Crashes only matter between two batches or between a batch and an external call. Inject a repository or D1 wrapper that throws after the Nth batch. Then re-run the handler, as a queue retry would, and assert convergence. Spying on `env.DB.batch` with `vi.spyOn` might work in the Workers pool (**UNCONFIRMED**); prefer an explicit seam. |
| Provider timeout / 5xx / 429 | `fetchMock` was removed; Cloudflare recommends `@msw/cloudflare` (2026-08-19). | MSW handlers with `delay()`, `HttpResponse.error()` and 429 with `Retry-After`. Or use the injected `fetch` the adapters already take. |
| Cron sweep | `createScheduledController({ scheduledTime, cron })` | Call `scheduled()` twice for the same `scheduledTime` to check idempotency. Since 2026-10-17, Local Explorer can also trigger crons locally. |
| Durable Object alarms | `runDurableObjectAlarm` | Not applicable: ShareRepo has no Durable Objects (AGENTS.md principle 12). |

- Storage is isolated per **test file**, not per test. `reset()` exists for `afterEach`.
- Sources:
  - https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
  - https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/
  - https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/
  - `node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts` (1.4.4)

## Implications for ShareRepo

1. **Timers:** keep `next_evaluation_at` plus the minutely sweep as the authority for grace expiry and effective cancellation. Record an ADR that answers the open question in `implementation-plan.md` ("Workflows versus database-scheduled jobs for each timer") with this analysis. Add Workflows only for multi-step repair or reconciliation jobs, if at all.
2. **If a Workflow is added:**
   - Define it in the jobs Worker. The web Worker gets a cross-script binding (`script_name`) only if it must start one.
   - Use per-environment Workflow names, because names are account-unique.
   - Use deterministic IDs without colons.
   - Treat "already exists" as success, and set `default_retention` explicitly.
   - Re-read D1 in a step after every sleep.
   - Keep step names stable across deploys.
3. **Queues:**
   - Add `dead_letter_queue` (for example `sharerepo-events-dlq-{dev,prod}`) and a DLQ consumer that persists a failure row correlated to workspace, subscription and resource, and emits an audit event.
   - Keep `max_retries` explicit.
   - Use `msg.retry({ delaySeconds })` from `attempts` and `Retry-After` for provider rate limits instead of throwing, so autoscaling is not penalised.
4. **Alerting:** Issues on both Workers, two Monitors (error lines, sweep heartbeat as a dead-man's switch), and a DLQ marker log. Add `observability.issues.enabled` to both configs, and to every environment block, so deploys do not turn it off.
5. **Backups:**
   - Rely on Time Travel for 30-day point-in-time recovery.
   - Add a scheduled `d1 export` to R2 for longer retention if the product needs it. Note that an export blocks the database while it runs, so schedule it off-peak and watch the 10 GB ceiling.
   - The runbook must rehearse both an in-place restore (dev) and export → import into a scratch database.
6. **Migrations:** each file is atomic, but a multi-file deploy is not. Keep expand/contract migrations and deploy code that tolerates both schemas. Record the bookmark from `wrangler d1 time-travel info` before every production migration.
7. **Secret rotation:** each Worker needs its own `wrangler secret put`, and each one redeploys that Worker. Keep `CREDENTIAL_KEYS` as a versioned key ring in this order:
   1. Add the new key to both Workers.
   2. Switch the primary key.
   3. Re-encrypt the envelopes.
   4. Remove the old key.

   Keep `CLAIM_SIGNING_KEY` multi-key the same way. Do not move to Secrets Store while it is in beta.
8. **Still UNCONFIRMED, to check in Phase 6:**
   - Workflows code-version behaviour on resume.
   - Cron retry semantics (`noRetry`).
   - Local DLQ routing in Miniflare.
   - Whether the SQL API exposes Queues data.
   - Issues plan availability and email destinations.
   - Monitors beta pricing.
   - Secrets Store update propagation.
   - The Workflows retention default (7 vs. 30 days) for a Workflow created now: read it back after the first deploy.
