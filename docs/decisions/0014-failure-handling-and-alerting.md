# 0014 — Failure records, a dead-letter queue, operator access and email alerts

**Status:** Accepted (alert channel and failure pages are product decisions, 2026-10-25)

## Context

`architecture.md` requires an inspectable failure path and an operator alert. Today:

- A queue message that exhausts `max_retries` is deleted, because no dead-letter queue is configured.
- An outbox row that fails for good gets `failed_at`, and nothing reads it.
- A repository that keeps failing to reconcile stores `reconcile_failures` and `last_reconcile_error`, and nobody sees them.
- Workspace owners see grant errors on the Access page and connection problems on the Repositories and Billing pages. There is no cross-workspace view and no alerting.

Cloudflare has no built-in alert for Worker errors, queue backlog or dead letters. The research found two options for one operator: Workers Issues, which groups errors and notifies, and the Monitors beta, which runs a scheduled SQL query over Workers Logs and emails.

## Decision

### Failures are rows

- **The outbox carries its workspace.** Migration 0009 adds a nullable `outbox.workspace_id`. It is set for every job about a workspace, and null for system-wide jobs such as the sweeps. Failure pages and alerts can then be scoped without guessing from `subject_id`.
- **A failed job is an outbox row with `failed_at`.** Rows that fail for good, run out of attempts, or reach the dead-letter queue all end there, with `last_error_code`.
  - Each such failure writes the audit event `job.failed`, with the kind, subject, error code and attempts, in the workspace when there is one.
- **A dead-letter queue** (`sharerepo-events-dlq-<env>`) receives messages that exhaust their queue retries. The jobs Worker consumes it. For each message it marks the row failed with `dead_lettered` unless the row was already sent or failed, writes `job.failed`, logs an alert line, and acks.
- **Resolving a failure** means retrying it or dismissing it.
  - **Retry** clears `failed_at`, resets `attempts` and makes the row available now. The audit event is `job.retried`.
  - **Dismiss** sets `dismissed_at`, with a reason. The audit event is `job.dismissed`.
  - The row is kept either way, for history, until pruning ([0015](0015-data-lifecycle.md)).
- **A repository's reconcile failures** remain on `resources`. The failure pages read them alongside job failures.

### Who sees what

- **Workspace owners** see their workspace's open failures on the Access page:
  - failed jobs about their subscriptions, offers or repositories;
  - repositories whose reconcile has failed 3 times or more in a row;
  - grants in error, as now.

  Each failure names the access it affects (repository, subscriber or offer) and has a Retry button. Owners cannot dismiss; they ask support.
- **Operators** see every workspace's failures on `/ops`:
  - open failed jobs, oldest first, with workspace, kind, error code, attempts and the affected access;
  - repositories with repeated reconcile failures;
  - connections that are suspended or unauthorized, and GitHub connections deleted in the last 30 days or that still have managed access ([amendment](#amendment--deleted-connections-and-waiting-purges-on-ops-phase-6-t6));
  - workspace deletions whose purge waits, with the reason;
  - sweep health: the oldest due evaluation and reconcile, and the last heartbeat.

  An operator can retry or dismiss a failure, and can open a workspace's Access page read-only.
- **An operator** is a user whose GitHub account ID is listed in the `OPERATOR_GITHUB_IDS` configuration value (comma-separated immutable IDs). There is no operator role in the database and no way to grant it from the product.
  - Every operator action is audited with actor type `operator`.
  - Reading another workspace's page as an operator is audited as `operator.viewed_workspace`.
  - Operator access never bypasses workspace scoping in queries. Operator routes call the same scoped services with an explicit operator principal.

### Alerts go to email

- **Workers Issues** is enabled on both Workers (`observability.issues.enabled`). Its automation emails the operator about new error groups. (Superseded: Issues cannot email; a Monitor does, see the amendment of 2026-10-25.)
- **Alert lines.** Code logs one structured line with `alert: "<name>"` for each condition that needs a person:
  - `job_failed`: a job failed for good or was dead-lettered;
  - `reconcile_failing`: a repository reached 3 consecutive reconcile failures;
  - `connection_lost`: a GitHub installation was suspended or deleted, or a Paddle connection became unauthorized;
  - `sweep_lagging`: the oldest due row is more than 15 minutes late.

  Alert lines carry IDs and codes only, never secrets or personal data.
- **Monitors** (Cloudflare, beta):
  - one emails on any alert line;
  - one emails when the minute heartbeat is missing for 15 minutes, which catches a cron that stopped.

  They are configured by hand from the runbook, because they have no Wrangler configuration yet.
- If Monitors leaves beta with a different shape, only the runbook changes. The code's contract is the alert line.

## Consequences

- Nothing that needs a person disappears silently. Each failure is a row, an audit event and an email.
- Operators get a cross-workspace view, without a database role that a bug could grant.
- `OPERATOR_GITHUB_IDS` must be set in each environment. Unset means no operators.
- Alerting depends on a Cloudflare beta. The runbook has a fallback: a daily review of `/ops`.

## Amendment — deleted connections and waiting purges on `/ops` (Phase 6 T6)

- **Deleted GitHub connections** are listed on `/ops` for 30 days after their deletion (`DELETED_CONNECTION_LISTED_MS`), and after that only while they still have managed grants: access ShareRepo created and may still need to revoke by hand. An old uninstall with nothing left to revoke is history, not a failure, and listing it for ever would bury the live ones.
- **A purge that waits** (decision 0015: `system_state` key `purge_blocked:<workspaceId>`) is shown on the owner's Access page under "Needs attention" and on `/ops`, with its reason, since when it waits and when it was last checked. It is not an outbox failure: the daily cron queues the purge again, so it needs no retry or dismissal. A workspace whose GitHub App was uninstalled before its purge waits on `managed_access_remaining` until an operator resolves it (incident runbook).

## Amendment — a provider outage does not fail jobs early (Phase 6 T6)

Fault injection found that an outage of about 15 minutes failed jobs for good:

- the outbox drain retried a row each time its one-minute lease expired, so its 10 attempts were spent in 10 minutes;
- the queue's 5 retries took about 15 minutes, and the dead-letter queue then marked the row failed.

A webhook's processing job then needed an operator, although the provider had recovered.

- **The drain backs off.** A retryable failure (`transient`, `rate_limited`, an unavailable Paddle connection, a concurrent writer) moves the row's `available_at` by `outboxRetryDelayMs`: 1 minute doubling per attempt, at most 2 hours, or the provider's reset when that is later. The waits before the 10th attempt add up to just over 6 hours, longer than the expiry confirmation window ([0013](0013-database-timers-and-expiry-confirmation.md)).
- **The queue hands over.** From the queue's last retry on (`QUEUE_MAX_RETRIES`, the events queue's `max_retries`), a retryable failure acknowledges the message and defers the row in the same way, so the drain takes it over. The dead-letter queue now receives only messages whose consumer crashed or timed out, and those are still failed with `dead_lettered`.
- A non-retryable failure is still recorded at once.

## Amendment — error emails come from a Monitor (2026-10-25)

The research found that Workers Issues automations do not offer email as a destination, so the decision above ("its automation emails the operator") cannot be met as written. The user, who is the operator, confirmed that email to them is enough for now.

- **A third Monitor emails on errors:** `error`-level log lines, and failed invocations where Workers Logs exposes them, from both Workers. It has the same shape and hourly repeat as the alert-line Monitor ([alerting setup](../runbooks/alerting-setup.md) § 1).
- **Workers Issues stays on** for grouping and history. If its automations offer email later, it may email too.
- All three Monitors send to the one operator address. The daily `/ops` review remains the fallback, and it includes a look at Issues.

## Amendment — sweep lag counts rate-limited repositories after a capped excuse (2026-10-25)

The sweep holds back a GitHub installation's due reconciles while it is rate-limited (`connections.rate_limited_until`, phase-6 plan § Partitioning). The lag alert left those repositories out altogether, and `/ops` counted them from their schedule. Both were wrong:

- just after a reset, the held-back repositories counted from their old `next_reconcile_at`, so `sweep_lagging` could fire before the sweep (10 per installation per tick) had worked through them;
- `rate_limited_until` only ever moves later and is never cleared, so an installation GitHub kept rate-limiting was left out for ever and never raised `sweep_lagging`.

**Decision.** One lateness measure, for the alert and the `/ops` panel alike. A repository's reconcile is due, for lag, at `max(next_reconcile_at, min(rate_limited_until, next_reconcile_at + RATE_LIMIT_EXCUSE_MS))` (`excusedReconcileDueAt`, `packages/domain/src/sweep.ts`), and lags once that is more than 15 minutes ago.

- **`RATE_LIMIT_EXCUSE_MS` is 1 hour:** GitHub's primary rate limit is an hourly budget per installation, so a reset is at most an hour away. A rate limit up to that is waited out without an alert; an installation still rate-limited after it is stuck, and its repositories count as lag.
- A reset in the past (or none) changes nothing, so a stale `rate_limited_until` needs no clearing.
- `/ops` also shows how many due repositories wait on a rate limit, as a separate figure: waiting is not lag.

## Amendment — operator list views are audited; operator changes need a fresh session (Phase 6 risk fixes)

- **`/ops` list views.** Each read of the cross-workspace lists writes `operator.viewed_failures`: account scope, actor type `operator` with the operator's user ID, target `ops_page`/`ops`, the request's correlation ID, and how many rows each list showed (`jobs`, `repositories`, `connections`, `purgesBlocked`), never their contents. As for `/ops/w/:slug`, a navigation whose `Sec-Fetch-Site` is `cross-site` or `same-site` reads and writes nothing: it gets a page with only a link to continue, which is same-origin.
- **Fresh sessions for retry and dismiss.** An operator's retry or dismissal needs a session created within `OPERATOR_SESSION_MAX_AGE_MS` (two hours, as GitHub's sudo mode). An older session gets "sign in again" and nothing changes; signing in again through GitHub starts a new session. Reading `/ops` does not need it. This bounds what a stolen or forgotten session cookie can change; it does not protect against someone who controls the operator's GitHub account.
- **No 2FA check.** GitHub returns `two_factor_authentication` only to tokens with the `read:user` or `user` scope ([REST: get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)). Sign-in requests no scopes ([0006](0006-authentication-with-better-auth.md)) and stores no token, so ShareRepo cannot see whether an operator uses two-factor authentication without widening sign-in for everyone. That stays an accepted risk: the operator list is short, and each operator must keep 2FA on their GitHub account.
