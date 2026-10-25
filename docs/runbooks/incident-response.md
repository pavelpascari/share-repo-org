# Runbook — incident response

What to do when something is wrong in a deployed environment: where to look first, how serious it is, and the procedures for the incidents Phase 6 anticipated. Day-to-day failures (a failed job, a repository that keeps failing) are in [failure triage](failure-triage.md). Background: decisions [0013](../decisions/0013-database-timers-and-expiry-confirmation.md), [0014](../decisions/0014-failure-handling-and-alerting.md) and [0015](../decisions/0015-data-lifecycle.md), and the [operations threat model](../security/operations-threat-model.md).

**Status:** written in Phase 6 T7 from the code. No procedure here has been rehearsed against a deployed environment yet.

## Running D1 queries

Some steps read or, as a last resort, change D1 directly. Run SQL against the same database the migrations use:

```sh
pnpm --filter @sharerepo/db exec wrangler d1 execute DB --remote -c ../../apps/web/wrangler.jsonc --command "<SQL>"
# production: add --env production
```

- Read before you write. Every write in this runbook is scoped by `workspace_id` and guarded on the state it expects, so running it twice, or against the wrong workspace, changes nothing.
- A hand-written change bypasses the audit trail. Record it in the incident note: what you ran, why, the IDs it touched and the number of rows written.
- Never paste query output with logins, emails or secrets into a ticket or chat.

## First steps

1. **Write an incident note** before you change anything: time, who is handling it, what was reported or alerted. Keep it outside ShareRepo's database, and keep IDs in it, not logins or emails.
2. **What raised it?**
   - An alert email from a Monitor: the alert name is in the line ([failure triage § Alert lines](failure-triage.md#alert-lines)).
   - A heartbeat Monitor email: the minute cron stopped or the jobs Worker fails before logging.
   - A Workers Issues notification: a new error group in one of the Workers.
   - A creator or subscriber report.
3. **Open `/ops`.** Check **Sweep health** (is the minute tick running and keeping up?), **Failed jobs**, **Connections that stopped working** and **Workspace deletions that wait**.
4. **Open Workers Issues** for both Workers (`sharerepo-web*`, `sharerepo-jobs*`) for error groups that started around the same time.
5. **Search Workers Logs.** Every line is JSON with a `correlationId`. Useful filters: the `alert` field; `outboxId`, `workspaceId`, `resourceId` or `connectionId` from an alert; `level` `error`. Logs carry IDs and classified codes, never provider messages.
6. **Is access wrong now?** For a workspace named in the report or alert, open its Access page read-only from `/ops` (**View access**, audited as `operator.viewed_workspace`).
7. **Decide the severity** (below) and work the matching procedure.

## Severity

| Severity | Examples | Response |
|---|---|---|
| **Critical** | Data of one workspace visible to another. A ShareRepo secret leaked. Subscribers across workspaces losing or keeping access wrongly. The jobs Worker down (no heartbeat). | Stop and fix now. Consider pausing deploys. |
| **High** | One workspace's subscribers lost access they paid for. A tenant credential leaked. Jobs failing for good across workspaces. | Same day. |
| **Normal** | A single failed job or failing repository. A purge that waits. A connection the owner must fix. | Within the daily `/ops` review. |

## A subscriber lost access they should have

Work from the subscriber's row on the workspace's Access page (owner, or **View access** for an operator). Each row shows the entitlement (desired access, with its reason), the grant (what GitHub shows) and what ShareRepo will do next.

1. **Is an entitlement live?**
   - **"Ending: confirming with Paddle"** (or "Ending: confirming the subscription"): the entitlement passed its `valid_until`, and ShareRepo is confirming the expiry with the source before revoking ([decision 0013](../decisions/0013-database-timers-and-expiry-confirmation.md)). Existing access is kept for up to 6 hours (`EXPIRY_CONFIRMATION_WINDOW_MS`) while the refresh re-reads Paddle. If Paddle shows the subscription renewed, the refresh continues the same entitlement. If Paddle cannot be read for 6 hours (an outage, or a connection whose key was refused), the access is revoked at the end of the window: fix the source (below), and the next refresh grants it again.
   - **Ended, with a reason:** compare the reason with the subscription in the creator's Paddle dashboard. If Paddle shows it active, ShareRepo missed or has not yet processed the change. An ended entitlement is never reopened: the next refresh that reads the subscription active creates a new one.
   - **No entitlement:** the customer may not be linked to the subscriber's GitHub account. Check the Customers page. The buyer claims (checkout or email), or the owner uses **Link customer** with a reason.
2. **Is Paddle readable?** On the Billing page, "Needs a new API key" means the connection is `unauthorized`: nothing is refreshed until the creator reconnects with a new key. ShareRepo keeps the last known facts meanwhile.
3. **Force a refresh** when the subscription is right in Paddle but not in ShareRepo. The daily Paddle sweep repairs it within a day; a new webhook does too. To run it now, queue the refresh by hand (the drain runs it within a minute; the job re-reads Paddle and is idempotent):

   ```sql
   INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, workspace_id)
   SELECT lower(hex(randomblob(16))), 'refresh_subscription',
          workspace_id || ':' || source || ':' || external_subscription_id,
          CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER), 0,
          workspace_id
   FROM subscriptions
   WHERE workspace_id = '<workspaceId>' AND external_subscription_id = '<sub_…>'
   ```

   Replaying the webhook from Paddle does not help: a replay has the same event ID, and ShareRepo ignores it as a duplicate.
4. **Is the grant wrong while the entitlement is live?**
   - "Waiting for the subscriber to accept": the invitation is pending on GitHub. The subscriber accepts it.
   - An error with **Retry**: the owner fixes the cause it names, then presses **Retry**.
   - Anything else: the owner presses **Check now**. Reconciliation re-reads GitHub and acts on what it finds.
5. **Check failures.** **Needs attention** on the Access page and **Failed jobs** on `/ops` name the jobs that stopped. Retry them as in [failure triage](failure-triage.md).
6. **Never add the collaborator by hand on GitHub as a fix.** Access ShareRepo did not create is unmanaged: ShareRepo reports it and never removes it, so it would outlive the subscription ([decision 0010](../decisions/0010-grant-ownership-and-reconciliation.md)).

The opposite case, a lapsed subscriber who keeps access, uses the same steps. Expect up to 6 hours past the boundary while Paddle cannot be read; that is decision 0013's bound, not an incident.

## A secret leaked

Rotate it with the [secret rotation runbook](secret-rotation.md), in the "if it leaked" form, production first if production is affected:

| Secret | Procedure |
|---|---|
| `CREDENTIAL_KEYS` | § 1. If a copy of the database may have leaked too, treat every tenant credential as compromised: creators reconnect with new Paddle API keys (§ 6) and rotate their webhook secrets (§ 5). |
| `CLAIM_SIGNING_KEY` | § 2, without the 8-day wait. |
| `GITHUB_WEBHOOK_SECRET` | § 3. |
| `GITHUB_APP_PRIVATE_KEY` | § 4. Deleting the key in GitHub ends it everywhere. |
| A creator's Paddle webhook secret | § 5: the owner presses **Rotate webhook secret** on the Billing page. |
| A creator's Paddle API key | § 6: the creator revokes it in Paddle and reconnects. |
| `BETTER_AUTH_SECRET` | § 7. Everyone is signed out. |

Not covered by the rotation runbook yet: `GITHUB_CLIENT_SECRET` (the sign-in OAuth App) and the deployment token `CLOUDFLARE_API_TOKEN`. Replace the OAuth App's client secret in its GitHub settings and set it with `wrangler secret put GITHUB_CLIENT_SECRET` on the web Worker; roll the Cloudflare token in the Cloudflare dashboard and update the GitHub Actions secret. Neither has been rehearsed.

After any leak, search Workers Logs and the audit events for use of the secret since the leak, and record what you found in the incident note.

## Restoring D1 (Time Travel)

D1 Time Travel restores a database to any minute in the last 30 days. The restore is **in place and destructive**: every write after the restore point is lost. Follow [backup and restore](backup-and-restore.md); it has the order of operations. Before you decide to restore, weigh what is lost:

- **GitHub access ShareRepo granted after the restore point** is no longer recorded as ShareRepo's. Reconciliation then finds those collaborators without an intent, records them as unmanaged, and never removes them. List them from the audit events or GitHub before restoring.
- **Paddle facts after the restore point** come back through the daily Paddle sweep, which refreshes any subscription newer than stored.
- **Purged workspaces** come back only by an in-place restore of the whole database ([decision 0015](../decisions/0015-data-lifecycle.md)).

## A workspace deletion that waits for ever

A due workspace purge first checks that ShareRepo has nothing left to revoke ([decision 0015](../decisions/0015-data-lifecycle.md)). If something remains, it changes nothing, records why in `system_state` (key `purge_blocked:<workspaceId>`, with `reason`, `since` and `checkedAt`), logs `job waits for a precondition`, and ends. The daily cron queues it again. It is shown under **Workspace deletions that wait** on `/ops` and under **Needs attention** on the owner's Access page. It is not a failed job: there is nothing to retry or dismiss.

### `entitlements_remaining`

Some entitlements are still `active`. Each waiting purge queues a refresh of every subscription in the workspace again, and a refresh of a workspace being deleted ends its entitlements with `workspace_deleted` without reading the source. It clears by itself. If it persists for more than a day, look for failed `refresh_subscription` jobs of that workspace on `/ops`.

### `managed_access_remaining`

**What it checks.** Any row in `grants` of the workspace with `managed = 1`, whatever its state (`provisioning`, `pending_invitation`, `active`, `revoking`, `error`). These are collaborators and invitations ShareRepo created and has not yet seen removed. Only an observation of the repository clears the flag: when the access is no longer listed, the grant becomes `absent` and unmanaged.

**Why it may never clear.** A reconciliation observes a repository only while its GitHub connection is `active` and the repository is still selected in the App. Otherwise it skips the repository and changes no grant. So the purge waits for ever when:

| Cause | Connection, repository | Recoverable in the product? |
|---|---|---|
| The owner **suspended** the App | `suspended` | Yes: the owner unsuspends it. |
| The owner **removed the repository** from the App's repository access | `active`, repository `removed` | Yes: the owner adds the repository back to the App's access. |
| The owner **uninstalled** the App before the purge | `deleted` | **No.** |
| The repository was **deleted** on GitHub | repository `removed` | No, but nothing is left to remove. |

An uninstall is final for ShareRepo. A resync of a `deleted` connection returns at once. Reinstalling the App creates a new installation, which is a new connection with new repository rows; the old grants still name the old connection and are never observed again. And a workspace being deleted cannot connect GitHub at all (writes need an `active` workspace). **So asking the owner to reinstall the App does not unblock the purge.**

**Procedure.**

1. **Find what remains:**

   ```sql
   SELECT g.id AS grant_id, g.state, g.subject_id, s.login_snapshot AS login,
          r.id AS resource_id, r.name_snapshot AS repository, r.selection,
          c.id AS connection_id, c.status AS connection_status
   FROM grants g
   JOIN subjects s ON s.workspace_id = g.workspace_id AND s.id = g.subject_id
   JOIN resources r ON r.workspace_id = g.workspace_id AND r.id = g.resource_id
   JOIN connections c ON c.workspace_id = g.workspace_id AND c.id = g.connection_id
   WHERE g.workspace_id = '<workspaceId>' AND g.managed = 1
   ```

2. **Suspended App, or repository removed from the App:** ask the owner to unsuspend the App, or add the repository back to its access. GitHub's webhook, or the daily resync, makes the connection `active` and the repository selected again. The repository's next reconciliation removes the collaborators and cancels the invitations (their entitlements have ended), and the grants become `absent`. The next daily purge then runs. Nothing by hand.
3. **Uninstalled App:** ShareRepo cannot remove the access. Only the repository owner can.
   1. Send the owner the list from step 1 (repository and login per row). Ask them to remove each collaborator and cancel each pending invitation in the repository's **Settings › Collaborators**, and to confirm when done.
   2. ShareRepo cannot check this: without an installation it cannot read the repository's collaborators. The owner's confirmation is the evidence. Keep it with the incident note.
   3. Then clear the managed flag on exactly those grants, as the observation would have. This is the last resort, run by hand:

      ```sql
      UPDATE grants
      SET state = 'absent', managed = 0, indirect = 0, external_grant_id = NULL, expires_at = NULL,
          last_error_code = NULL, retry_class = NULL, next_attempt_at = NULL,
          updated_at = max(updated_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      WHERE workspace_id = '<workspaceId>'
        AND managed = 1
        AND connection_id IN (SELECT id FROM connections
                              WHERE workspace_id = '<workspaceId>' AND status = 'deleted')
        AND EXISTS (SELECT 1 FROM workspaces
                    WHERE id = '<workspaceId>' AND status = 'deleting'
                      AND NOT EXISTS (SELECT 1 FROM entitlements
                                      WHERE workspace_id = '<workspaceId>' AND state = 'active'))
      ```

      The rows written must equal the step 1 rows on `deleted` connections. It changes nothing unless the workspace is still `deleting` with no live entitlement, and it touches only grants of uninstalled connections.
   4. **It bypasses the audit trail**, and the purge then deletes the workspace's own audit events; the tombstone `workspace.purged` keeps only counts. The incident note is therefore the only record. Write in it: the workspace ID, every grant ID and subject ID cleared (not logins), the owner's confirmation and its date, who ran the statement, when, and the rows written.
4. **Repository deleted on GitHub:** a deleted repository has no collaborators left. Confirm with the owner that it was deleted, not transferred, then use the statement in step 3.3 with `AND resource_id = '<resourceId>'` in place of the `connection_id` condition, and record it the same way.
5. **Let the purge run.** The next daily cron queues it, spread over the day. To run it within a minute instead:

   ```sql
   INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts)
   VALUES (lower(hex(randomblob(16))), 'purge_workspace', '<workspaceId>',
           CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER), 0)
   ```

   Check that **Workspace deletions that wait** no longer lists it, and that an account-scoped `workspace.purged` event exists for the workspace ID. Until Time Travel's 30 days pass, an in-place restore can still bring it back.

**If the owner cannot be reached** (the App was uninstalled and the owner does not answer, or has deleted their account), there is no safe path. ShareRepo cannot remove the collaborators, and nobody can confirm they were removed. Clearing the flags would purge ShareRepo's only record of who it gave access to, while those people may still have it. Leave the purge waiting: it costs one check a day and changes nothing. Whether to purge anyway after some period is an open product decision, not an operator's call.

**Prevention.** The owner's settings page tells them to uninstall the App only once the workspace is deleted, and the waiting message says "Keep the GitHub App installed until the workspace is deleted, so it can remove them."
