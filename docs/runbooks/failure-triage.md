# Runbook — failure triage

How to read the failure pages, what each job and error code means, and when to retry or dismiss. Background: [decision 0014](../decisions/0014-failure-handling-and-alerting.md) and its amendments, and the [operations threat model](../security/operations-threat-model.md). For incidents (wrong access, a leaked secret, a restore, a purge that waits for ever) see [incident response](incident-response.md). For setting up the alert emails see [alerting setup](alerting-setup.md).

**Status:** written in Phase 6 T7 from the code. The pages and alert lines are tested; no step has been rehearsed against a deployed environment yet.

## Where failures show

Every failure that needs a person is a row, an audit event and an alert line. Two pages show them.

### The owner's Access page

A workspace's **Access** page has a **Needs attention** section while anything is open:

- **Failed jobs** about the workspace's subscriptions, offers, repositories and connections: "These jobs stopped retrying." Each row says what the job did, what it affects (repositories, subscribers, offers, a connection or a webhook), why it failed and when. An owner of an `active` workspace (`workspace.manage`) has **Retry**. Owners cannot dismiss: they ask support. An owner cannot retry a failure an operator dismissed.
- **Repositories that keep failing to check:** selected repositories whose last 3 or more checks failed in a row, with the latest reason.
- **Workspace deletion:** a due deletion whose purge waits, with the reason, since when, and when it was last checked.

Grant errors stay on each access row, with their own **Retry**, and each repository has **Check now**.

Rows queued before migration 0009, and system-wide jobs, have no workspace. They show only on `/ops`.

### `/ops`, for operators

An operator is a signed-in user whose GitHub account ID is listed in `OPERATOR_GITHUB_IDS` on the web Worker ([deployment](../deployment.md)). Everyone else gets a 404. `/ops` has five sections:

| Section | Shows | Controls |
|---|---|---|
| **Sweep health** | Last heartbeat, oldest due subscription check, oldest due repository check, oldest due job, each with how many minutes ago | None |
| **Failed jobs** | Every workspace's open failures and the system-wide ones, oldest first, up to 200 | **View access**, **Retry**, **Dismiss** with a reason |
| **Repositories that keep failing to check** | Selected repositories with 3 or more failures in a row, with workspace | None |
| **Connections that stopped working** | GitHub installations suspended or uninstalled, and Paddle connections whose key was refused. An uninstalled one is listed for 30 days, then only while it still has managed access | Link to the workspace |
| **Workspace deletions that wait** | Due purges that wait, with the reason | Link to the workspace |

**View access** (or a workspace link) opens `/ops/w/<slug>`: the workspace's Access page, read-only, with its failures and every control off. Each load is audited as `operator.viewed_workspace` in that workspace, so open it when you need it, not to browse. Retry is audited as `job.retried` and dismissal as `job.dismissed`, both with actor type `operator`.

## Reading sweep health

- **Last heartbeat** is written by every minute tick of the jobs Worker. "Unknown" means it was never written. More than 2–3 minutes old means the minute cron is not running, the jobs Worker fails before the heartbeat, or the GitHub App is not configured there (the minute tick then skips everything). Check the jobs Worker's Workers Logs for `invalid environment configuration` or `GitHub App not configured; skipped`.
- **Oldest due subscription check, repository check, job.** "Nothing due" is normal. A few minutes is normal: each tick queues at most 100 evaluations and 100 reconciles (at most 10 per GitHub installation), and the drain runs for about 20 seconds. More than 15 minutes raises `sweep_lagging` (below).
- The page and the alert count slightly differently. The page shows every due row. The alert leaves out repositories of a rate-limited installation (they wait on purpose until `rate_limited_until`) and jobs that ran out of attempts (they are failures). So the page can show a repository check more than 15 minutes late without an alert: check **Repositories that keep failing to check** for `rate_limited`.

## Job kinds

The pages name each job by what it does (`apps/web/app/failure-messages.ts`):

| Kind | Shown as | Workspace on the row |
|---|---|---|
| `process_external_event` | Processing a webhook | Paddle: its connection's workspace. GitHub: none (system-wide) |
| `resync_connection` | Syncing repositories from GitHub | Yes |
| `refresh_subscription` | Updating a subscriber's access | Yes |
| `recompute_offer` | Applying an offer change | Yes |
| `reconcile_resource` | Updating repository access on GitHub | Yes |
| `send_claim_email` | Sending a purchase claim email | Yes |
| `check_paddle_connection` | Checking the Paddle connection | Yes |
| `sweep_paddle_subscriptions` | Checking subscriptions with Paddle | Yes |
| `prune_data` | Removing old operational data | None |
| `purge_workspace` | Deleting a workspace | None |
| `rewrap_credentials` | Re-encrypting stored credentials | None |

A job with no workspace shows only on `/ops`, as "System".

## How a job fails

A job runs on the queue first (the fast path), and the outbox drain runs it every minute if the queue did not finish it (the safety net). Every job re-reads its inputs and is idempotent, so running it again is always safe.

- **Retryable** errors: GitHub or Paddle unavailable (`transient`, which includes a request that hit its 20-second timeout), rate limited (`rate_limited`), a Paddle connection that cannot be read now (inactive, key refused, or no commerce secrets), or a resync or refresh that kept losing to concurrent writers.
  - **On the queue:** retried after 30 seconds, doubling, at most 15 minutes, or the provider's reset when it gave one. From the fifth delivery on (`QUEUE_MAX_RETRIES`, the events queue's `max_retries`), the consumer acknowledges the message and hands the row to the drain instead. A retryable failure is never dead-lettered.
  - **In the drain:** the row waits 1 minute, doubling per attempt, at most 2 hours, or the provider's reset when later. Its 10th attempt (`OUTBOX_MAX_ATTEMPTS`) comes about 6 hours after the first, later than the expiry confirmation window ([decision 0013](../decisions/0013-database-timers-and-expiry-confirmation.md)). Only a failure on the 10th attempt is final.
- **Non-retryable** errors fail the row at once, on either path.
- **A final failure** marks the outbox row failed with a classified error code, writes `job.failed` (in the row's workspace, or account-scoped when it has none) and logs the `job_failed` alert line. Nothing else changes.

### The dead-letter queue

- The events queue (`sharerepo-events-dev`, `sharerepo-events-prod`) sends a message that used up its 5 retries to `sharerepo-events-dlq-dev` or `sharerepo-events-dlq-prod`.
- Since retryable failures are handed to the drain, a message reaches the dead-letter queue only when its consumer crashed or timed out on every delivery, for example a D1 error while recording the outcome, or the Worker exceeding its limits.
- The jobs Worker consumes the dead-letter queue. It validates each message and **never runs the job**. If the message's outbox row is unsent and unfailed and has the same kind and subject, the row is failed with `dead_lettered`, with `job.failed` and the alert line. Otherwise it logs `dead-lettered message matched no open job` (a replay, or a row the drain already finished) or `invalid dead-lettered message dropped`, and acknowledges.
- If recording fails, the message is retried, up to 5 times. The dead-letter queue has no dead-letter queue of its own: after that the message is deleted. The row is then still pending, so the drain runs it.

## Error codes

The **Why** column explains the code. Codes not in this table are shown as "It failed (`<code>`)".

| Code | Shown as | Usual cause | What to do |
|---|---|---|---|
| `transient` | GitHub or Paddle was unavailable each time it ran. | An outage longer than the drain's 6 hours, or a timeout every time | Check the provider's status. **Retry** once it answers. |
| `rate_limited` | GitHub or Paddle rate limits stopped it each time it ran. | A large backlog against one installation or seller | Wait for the limit to reset, then **Retry**. If it recurs, look at what queues the work (Workers Logs). |
| `unauthorized` | Paddle refused the API key. | The creator's key was revoked, expired or lost a permission | The owner reconnects with a new key on the Billing page ("Needs a new API key"). Then **Retry**. |
| `suspended` | The GitHub App installation is suspended. | The owner suspended the App | The owner unsuspends it on GitHub. The resync after the webhook, or the daily one, restores the connection. Then **Retry**. |
| `not_found` | Something it needs no longer exists on GitHub or Paddle. | A repository, account, installation or Paddle object was deleted | Check the workspace's access is right (**View access**). Usually **Dismiss**: the resync or the next refresh already reflects the deletion. |
| `rejected` | GitHub or Paddle refused the request. | A request the provider will not accept as sent | Find the job's lines in Workers Logs by `outboxId`; the code is classified, never the provider's message. Fix the cause, then **Retry**, or **Dismiss** if the work is no longer needed. |
| `malformed` | Paddle sent a response ShareRepo could not read. | A Paddle API change, a body cut short, or too many pages | Treat as a bug until shown otherwise. **Retry** once; if it fails again, keep it open and fix the adapter. |
| `malformed_response` | GitHub sent a response ShareRepo could not read. | The same, for GitHub | As `malformed`. |
| `key_invalid` | The job could not be read. | A job key that does not decode: a bug, or a hand-written row | **Dismiss** with the reason. It can never succeed. |
| `source_unavailable` | Its billing source is not available here. | A simulated subscription's refresh in production | **Dismiss**. The simulator never runs in production. |
| `internal_error` | Something went wrong while it ran. | A bug or a storage error | Look in Workers Issues and Workers Logs around the failure time. **Retry** once the cause is fixed. |
| `dead_lettered` | It kept failing and its retries ran out. | The consumer crashed or timed out on every delivery | Look in Workers Issues for that time. **Retry** once: the drain then runs it with backoff. |
| `not_implemented` | This job is not available yet. | No longer produced: every kind has a handler since Phase 6 T5 | Only a row that failed while its kind had no handler. **Retry**. |

## Retry or dismiss

- **Retry** when the job's work is still needed and its cause is gone. Retry clears the failure, resets the attempts and makes the row due now; the page also hands it to the queue. It is always safe: every job re-reads current state.
- **Dismiss** when the work is no longer needed or can never succeed: the subject is gone, a later job already did the work, or the job cannot be read. Write a reason a later reader understands (required, at most 500 characters), for example "subscription deleted in Paddle; access confirmed absent on View access". The row is kept for 90 days, then pruned.
- Before dismissing anything that affects access, open **View access** and check that each named subscriber's access is what it should be.
- A failure that comes back after a retry needs a cause, not another retry.
- `purge_workspace`, `prune_data` and `rewrap_credentials` are re-queued by the daily cron. A failed one can be retried; dismissing it does not stop the next day's run.

## Repositories that keep failing to check

Each check reads the repository's collaborators and invitations from GitHub. After a failure, the next check backs off 1, 5, 15, then 60 minutes; the grants are left alone. The reason shown:

| Code | Shown as | What to do |
|---|---|---|
| `provider_unavailable` | GitHub was unavailable. | Nothing; it retries. Act only if GitHub is up and it persists. |
| `rate_limited` | GitHub rate limits stopped the check. | Nothing; the installation's other checks wait until the reset (`rate_limited_until`). |
| `provider_rejected` | GitHub refused the check. | Often a missing permission (Administration: Read and write). The owner accepts the App's permission request on GitHub. |
| `malformed_response` | GitHub sent a response ShareRepo could not read. | Treat as a bug. |
| `suspended` | The GitHub App installation is suspended. | The owner unsuspends it. |
| `repository_not_found` | The repository was not found on GitHub. | A resync runs and marks it removed if it is gone. |
| `installation_missing` | The GitHub App is no longer installed. | See [incident response](incident-response.md) § Managed access after the App was uninstalled. |

Once the cause is fixed, the owner presses **Check now** on the Access page.

## Alert lines

Code logs one structured line for each condition that needs a person, at `warn` level: message `alert: <name>`, with the field `alert` set to the name and IDs and codes only, never secrets or personal data. A Cloudflare Monitor emails on any of them ([alerting setup](alerting-setup.md)). The names are a closed list (`packages/domain/src/alert.ts`):

| Alert | Raised when | Fields | What to do |
|---|---|---|---|
| `job_failed` | A job failed for good: a non-retryable error, the drain's 10th attempt, or the dead-letter queue | `outboxId`, `kind`, `errorCode`, `attempts`, and `workspaceId` when the row has one | Find it under **Failed jobs** on `/ops` and follow § Error codes. `attempts` is 0 on the queue path, which does not count attempts on the row. |
| `reconcile_failing` | A repository's check failed for the third time in a row (raised once, by the run that recorded it) | `workspaceId`, `resourceId`, `failures`, `errorCode` | Find it under **Repositories that keep failing to check** and follow the table above. |
| `connection_lost` | A resync moved a GitHub connection to `suspended` or `deleted`, or a Paddle connection became `unauthorized` | `workspaceId`, `connectionId`, `provider`, `status` | Check **Connections that stopped working**. The owner must act: unsuspend, reconnect, or reconnect Paddle with a new key. If the workspace is being deleted and the App was uninstalled, its purge will wait (incident response). |
| `sweep_lagging` | The oldest due evaluation, reconcile or job is more than 15 minutes late (at most once per 15 minutes) | `oldestEvaluationDueAt`, `oldestReconcileDueAt`, `oldestOutboxDueAt`, `lagMs` | Check **Sweep health**. Look for errors in the jobs Worker's logs (`due evaluation sweep failed`, `due reconcile sweep failed`, `outbox job failed`), a provider outage, or a backlog after downtime, which drains oldest first. |

A missing heartbeat raises no alert line: the heartbeat Monitor catches it ([alerting setup](alerting-setup.md)).

## Logs worth knowing

All are JSON lines in Workers Logs, with a `correlationId`. Each job has its own.

| Message | Worker | Meaning |
|---|---|---|
| `sweep.heartbeat` | jobs | The minute tick ran; fields as in Sweep health, plus `lagMs` |
| `outbox drained` | jobs | `claimed` and `sent` for the tick |
| `outbox job failed` | jobs | A drained job failed; `final` says whether for good |
| `job will be retried` | jobs | A queue retry, with `delaySeconds` |
| `job handed to the outbox drain` | jobs | A retryable failure on the queue's last retries |
| `job failed` | jobs | A queue job failed for good (error level, so Workers Issues sees it) |
| `job waits for a precondition` | jobs | A purge waits (see incident response) |
| `dead-lettered message matched no open job` | jobs | A dead-lettered message for a row already finished |
| `credential rewrap check` | jobs | The daily check; `queued` says whether a rewrap run was queued |
| `lifecycle jobs queued`, `paddle sweeps queued`, `daily resync queued` | jobs | The daily cron's queueing |
