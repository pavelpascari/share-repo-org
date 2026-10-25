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

- **Workers Issues** is enabled on both Workers (`observability.issues.enabled`). Its automation emails the operator about new error groups.
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
