# Runbook — alerting setup

How the operator learns that something needs a person: Workers Logs, Workers Issues, three hand-configured Monitors that email (alert lines, errors, heartbeat), and the daily `/ops` review as the fallback. Background: [decision 0014](../decisions/0014-failure-handling-and-alerting.md) § Alerts go to email, and [research](../research/cloudflare-durability.md) § Alerting options. What each alert means is in [failure triage](failure-triage.md#alert-lines).

**Status:** written in Phase 6 T7. Everything marked **(not verified)** needs a deployed environment and has not been checked yet. Monitors is a Cloudflare beta, so its screens may differ from this text. If they do, change this runbook, not the code: the code's contract is the log line.

## What the code provides

- **Workers Logs** is on for both Workers (`observability.enabled`). Every line is one JSON object with `ts`, `level`, `msg` and `correlationId`, plus fields. Nothing else needs setting up.
- **Workers Issues** is on for both Workers in every environment (`observability.issues.enabled: true` in each environment block of `apps/web/wrangler.jsonc` and `apps/jobs/wrangler.jsonc`). A deploy without the setting turns Issues off, so keep it in every block. Issues groups uncaught exceptions, failed invocations, 5xx responses and `error`-level lines.
- **Alert lines.** One `warn` line per condition that needs a person: `msg` is `alert: <name>`, the field `alert` is the name, and the other fields are IDs and codes only. The names: `job_failed`, `reconcile_failing`, `connection_lost`, `sweep_lagging`. They are `warn`, not `error`, so Issues does not see them: the alert Monitor does.
- **The heartbeat.** Every minute tick of the jobs Worker logs `msg: "sweep.heartbeat"` after its sweeps and drain, even when the drain failed. The minute tick skips everything, heartbeat included, when the GitHub App is not configured on the jobs Worker (`GITHUB_APP_ID` empty), so set the heartbeat Monitor up only where the App is configured. The hourly `scheduled heartbeat` line is a different, older line; do not use it for the Monitor.

## 1. Workers Issues

For each Worker in each environment (`sharerepo-web`, `sharerepo-jobs`, `sharerepo-web-production`, `sharerepo-jobs-production`):

1. In the Cloudflare dashboard, open the Worker's **Issues** and check it lists the Worker after the first deploy.
2. Add an **automation**: notify on a new issue (an occurrence threshold of 1), and again when an issue recurs after a period of inactivity.
3. Destination: Issues automations offer webhook, chat, incident-tool and coding-agent destinations, not email (research; **not verified** in the dashboard). If email is offered, use it. Otherwise leave the automation without a destination and rely on the **error-line Monitor** below, which emails the operator ([decision 0014 amendment](../decisions/0014-failure-handling-and-alerting.md#amendment--error-emails-come-from-a-monitor-2026-10-25)).

**Error-line Monitor.** Create it next to the two in § 2 and § 3:

| Setting | Value |
|---|---|
| Dataset | `logs.workersLogs` |
| Workers | the same as § 2 |
| Query | Count of log lines whose `level` is `error`, plus invocations whose outcome is an exception, as the editor exposes them |
| Schedule | Every 5 minutes, over the last 5 minutes |
| Condition | Threshold: count `> 0` |
| Destination | Email to the operator |
| Name | `sharerepo errors (<env>)` |

Check in the editor which field holds the invocation outcome **(not verified)**; if none does, count `error` lines only and rely on Issues (checked in the daily `/ops` review) for uncaught exceptions. Keep the default hourly repeat.

## 2. Monitor: any alert line

In the Cloudflare dashboard, under **Monitors** (beta), create one Monitor per environment, or one covering both:

| Setting | Value |
|---|---|
| Dataset | `logs.workersLogs` |
| Workers | `sharerepo-web`, `sharerepo-jobs` (dev); `sharerepo-web-production`, `sharerepo-jobs-production` (production) |
| Query | Count of log lines that have an `alert` field |
| Schedule | Every minute, over the last 5 minutes |
| Condition | Threshold: count `> 0` |
| Destination | Email to the operator |
| Name | `sharerepo alert lines (<env>)` |

- Write the query in the Monitor's SQL editor against the dataset's schema as the editor shows it. **(not verified)** Workers Logs extracts the fields of JSON log lines, so `alert` should be queryable as its own field; check that in the editor with a real alert line (§ 5) before relying on it. If it is not, match on `msg` starting with `alert: `.
- Include the alert name and the IDs in the notification if the editor allows a group-by or a message template. The IDs lead straight to the row on `/ops`.
- Repeat notifications default to once an hour. Keep that: one email per alert per hour is enough for one operator.

## 3. Monitor: the heartbeat (dead-man's switch)

| Setting | Value |
|---|---|
| Dataset | `logs.workersLogs` |
| Workers | `sharerepo-jobs` (dev) or `sharerepo-jobs-production` |
| Query | Count of log lines whose `msg` is `sweep.heartbeat` |
| Schedule | Every 5 minutes, over the last 15 minutes |
| Condition | Threshold: count `< 1` |
| Destination | Email to the operator |
| Name | `sharerepo heartbeat (<env>)` |

It fires when the minute cron stopped, the jobs Worker fails before it logs (for example invalid configuration, which logs `invalid environment configuration` at `error` and reaches Issues too), or the GitHub App was unconfigured. A lagging sweep that still runs keeps the heartbeat and raises `sweep_lagging` instead.

## 4. Email

- Monitors send to up to 20 email recipients. Use one operator address, ideally a shared inbox or alias rather than a person's mailbox.
- Check that Cloudflare's notification emails are not filtered as spam: send a test (§ 5) and mark it as not spam.
- **(not verified)** Monitors' beta pricing is not stated. Check the account's billing page after creating them.

## 5. First-deploy checks

Run these in **dev** after the first deploy that includes Phase 6, then in production with the same steps where they are safe. Record the date and result of each in [deployment.md](../deployment.md) § First-deploy checks or the incident log.

1. **Issues is on.** Both Workers appear under Issues. **(not verified)**
2. **An alert line reaches the email.** In dev only, queue a job that can never succeed. Its key does not decode, so it fails at once with `key_invalid`, writes `job.failed` (account-scoped) and logs `alert: job_failed`:

   ```sh
   pnpm --filter @sharerepo/db exec wrangler d1 execute DB --remote -c ../../apps/web/wrangler.jsonc --command "
     INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts)
     VALUES (lower(hex(randomblob(16))), 'refresh_subscription', 'alert-test',
             CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER), 0)"
   ```

   Within a few minutes: the line appears in Workers Logs with `alert: "job_failed"`, the Monitor emails, and `/ops` lists the job as "System", "Updating a subscriber's access", "The job could not be read." Then **Dismiss** it on `/ops` with the reason "alerting test". That also checks the operator's access and the dismissal audit.
3. **The heartbeat Monitor works.** Open its query preview: it should count about 15 lines for the last 15 minutes. To see the email once, raise the threshold to `< 100` for one evaluation, then set it back to `< 1`.
4. **The dead-letter queue is routed.** In the dashboard, the events queue (`sharerepo-events-dev`) shows `sharerepo-events-dlq-dev` as its dead-letter queue, and both queues show `sharerepo-jobs` as their consumer. **(not verified)** To exercise the consumer without failing a real job, send a message to the dead-letter queue from the dashboard's queue page, if it offers sending, with the body `{"kind":"refresh_subscription","subjectId":"dlq-test","outboxId":"dlq-test"}`. The jobs Worker logs `dead-lettered message matched no open job` and acknowledges it; nothing changes in D1. A real dead letter only happens when the consumer crashes, which cannot be caused safely.
5. **Operators.** With `OPERATOR_GITHUB_IDS` set, `/ops` loads for the operator and answers 404 to another signed-in account and to a signed-out browser.

## The fallback: a daily `/ops` review

Until Monitors leaves beta and has proved itself, open `/ops` in production once a day:

- **Sweep health:** a last heartbeat within the last 2 minutes, and no due row older than 15 minutes. Repository checks are measured as `sweep_lagging` measures them: one held back by a GitHub rate limit counts from the reset, by at most an hour ([failure triage](failure-triage.md) § Reading sweep health).
- **Failed jobs:** none open longer than a day without a note.
- **Connections that stopped working** and **Workspace deletions that wait:** each one has an owner who was told.

Also skim Workers Issues for new groups. The review is what catches an alert Monitor that silently stopped working.
