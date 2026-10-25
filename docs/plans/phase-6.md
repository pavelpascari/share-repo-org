# Phase 6 plan — Durable timing and operational hardening

Source: `implementation-plan.md` § Phase 6. Decisions:
- [0013](../decisions/0013-database-timers-and-expiry-confirmation.md): timers stay in the database; expiry is confirmed before revocation.
- [0014](../decisions/0014-failure-handling-and-alerting.md): failure records, dead-letter queue, operator access, email alerts.
- [0015](../decisions/0015-data-lifecycle.md): retention, export, workspace deletion, account deletion.

Research: [cloudflare-durability.md](../research/cloudflare-durability.md).

## Goal

Make delayed policy, retries and recovery safe enough for the founder launch:

1. A subscriber whose renewal webhook was lost is never revoked at the old boundary (decision 0013).
2. A sweep that stops, lags or replays is noticed and harmless.
3. Every failure that needs a person is a row, an audit event and an email. Owners see and retry their own; operators see and resolve all of them on `/ops`.
4. Old operational data is pruned. Owners can export and delete a workspace, and users can delete their account, with access revoked first.
5. Every ShareRepo and tenant secret can be rotated without downtime, by a written procedure.
6. Crashes, timeouts, duplicate delivery and provider outages are tested at the entry points.
7. Backup, restore and migration procedures are written down and rehearsed.

## Out of scope

- Cloudflare Workflows (decision 0013).
- A central Paddle or GitHub rate limiter. Phase 6 spreads the daily work instead (see Partitioning). Decision 0011 keeps the limiter until volume needs one.
- Ownership transfer, multiple owners and member management.
- Privacy policy text, public status page and support tooling (Phase 8).
- Logpush, Tail Workers and Analytics Engine dashboards. Cloudflare's dashboards and Workers Logs are enough at this size.

## Design summary

### Expiry confirmation (decision 0013)

- **Planner.** The planner's entitlement filter becomes three-way for an `active` entitlement:
  - **desired**: `valid_until` is null or in the future;
  - **expiry pending**: `valid_until <= now < valid_until + EXPIRY_CONFIRMATION_WINDOW`. It neither grants nor revokes; existing access, pending invitations and managed grants stay as they are;
  - **not desired**: past the window.

  `expired` and `revoked` entitlements are not desired, as now.
- **Schedule.** `nextReconcileAt` schedules a check at `valid_until + EXPIRY_CONFIRMATION_WINDOW` for an expiry-pending entitlement, so the bounded revoke happens even if nothing else wakes the repository.
- **Refresh.** The refresh that ends the entitlement already queues the resource's reconcile, so revocation follows within a tick.
- The access page shows an expiry-pending row as "Ending: confirming with Paddle".

### Sweep health

- Each minute tick logs `sweep.heartbeat` with: claimed evaluations, claimed reconciles, drained outbox rows, and the oldest due `next_evaluation_at`, `next_reconcile_at` and outbox `available_at`.
- When the oldest due row is more than 15 minutes late, the tick also logs `alert: "sweep_lagging"`, at most once per 15 minutes (the last time is stored in a `system_state` row).
- **Indexes** for the sweeps' repair queries: `entitlements(state, valid_until)` and `outbox(kind, subject_id) WHERE sent_at IS NULL AND failed_at IS NULL`.

### Partitioning

- **Daily GitHub resync.** Each connection's daily `resync_connection` is spread over the day: it gets an `available_at` offset of `hash(connectionId) mod 24h`, instead of all connections running at 03:17.
- **Daily Paddle sweep.** Spread the same way, with its own hash.
- **Per-tick reconciles.** The reconcile sweep claims at most 10 due resources per GitHub installation per tick, and at most 100 in all. One large installation can no longer starve the others or burn its rate limit in one minute.
- **Rate-limit errors.** A GitHub `rate_limited` error during a reconcile defers that installation's other due reconciles until its reset. The installation's `rate_limited_until` is stored on the connection row.

### Failures, operator, alerts (decision 0014)

- **Schema.** `outbox.workspace_id` (nullable, with a composite foreign key) plus `dismissed_at`, `dismissed_by` and `dismiss_reason`. The partial index `outbox_open_failures_idx(workspace_id, failed_at) WHERE failed_at IS NOT NULL AND dismissed_at IS NULL`.
- Every `dedupedOutboxInsert` call passes the workspace.
- **Dead-letter queue.** Add `dead_letter_queue` to the jobs consumer config, and a second consumer for the DLQ.
- **Services:** `listOpenFailures(workspace)`, `listAllOpenFailures(operator)`, `retryFailure`, `dismissFailure`.
  - Each failure resolves to its affected access: the outbox kind and subject give a subscription, offer, resource or connection. From there the service finds the repository and subscriber names.
- **Operator principal.**
  - `requireOperator(request)` checks the signed-in user's GitHub ID against `OPERATOR_GITHUB_IDS`. Anyone else gets a 404, so the page's existence is not revealed.
  - Operator services take an `OperatorPrincipal`, and every query still filters by an explicit `workspaceId` argument.
- **Alert lines** are logged through one helper, `alert(name, ids)`, so the names are a closed vocabulary with a test.
- **Configuration.** `observability.issues.enabled: true` in every environment of both Workers.

### Data lifecycle (decision 0015)

- **Migration 0009:**
  - workspace statuses `deleting` and `purging`, with `delete_after` and `deletion_requested_by`;
  - `system_state(key, value, updated_at)`;
  - the outbox columns above;
  - the audit DELETE trigger, with the `purging` exception;
  - the retention indexes needed for bounded deletes.
- **Jobs:**
  - `prune_data`: daily, spread like the sweeps;
  - `purge_workspace`: daily per `deleting` workspace past `delete_after`, re-queued while rows remain.
- **Pages:**
  - workspace settings: export, delete and cancel deletion;
  - account (`/me`): delete account.
- **Entitlement end reasons** `workspace_deleted` and `account_deleted` go through the existing recompute. The policy treats a workspace in `deleting`, or a subject with no linked user after an account deletion, as "no access desired".

### Secret rotation

| Secret | Mechanism |
|---|---|
| `CREDENTIAL_KEYS` | Keyring, lazy rewrap (Phase 5). Add a `rewrap_credentials` job that rewraps every envelope still under a non-current key, so the old key can be removed. The runbook covers the two-Worker deploy window: add the key to both Workers first, then make it current. |
| `CLAIM_SIGNING_KEY` | Becomes a keyring like `CREDENTIAL_KEYS`. References carry no key ID, so verification tries the current key, then the others. New references use the current key. |
| `GITHUB_WEBHOOK_SECRET` | `GITHUB_WEBHOOK_SECRET_PREVIOUS` is accepted while set. Procedure: set previous to the old value, set the new value in GitHub and in the secret, then remove previous. |
| `GITHUB_APP_PRIVATE_KEY` | GitHub allows two active keys. Procedure: generate a second key, replace the secret, delete the old key in GitHub. Runbook only. |
| Paddle webhook secret (per connection) | A "Rotate webhook secret" action on the billing page. It creates a second destination at the same URL with a `?v=2` marker, stores its secret as `webhook_secret_next`, accepts both, then deletes the old destination and promotes the new secret. A failure at any step leaves both working. Audited as `paddle.webhook_secret_rotated`. |
| Paddle API key | A reconnect (Phase 5). |
| `BETTER_AUTH_SECRET` | Runbook: rotating it signs everyone out. |

### Fault injection

- **Crash between batches.** A test helper wraps the D1 binding so that the Nth `batch()` throws after (or before) committing. Every multi-batch operation runs with N = 1…k. The test then re-runs the job and asserts the same final state and audit trail as a clean run. Covered operations:
  - a subscription refresh;
  - a reconcile run;
  - Paddle connect;
  - a claim;
  - a workspace purge;
  - an account deletion.
- **Duplicate delivery.** `createMessageBatch` with the same message twice, with `attempts > 1`, and DLQ delivery of an already-sent row.
- **Timeouts.** The fakes gain a "hang" fault that exceeds the client timeout. A timeout must be retryable.
- **Provider outage.** The fakes return 5xx for a window, then recover. The reconcile and refresh must converge, and the outage must produce no revocation, which exercises the expiry confirmation.
- **Sweep replay.** The same scheduled tick run twice, and the same due row claimed twice, change nothing the second time (`timing/sweep-replay-is-idempotent`).

### Backup, restore, migrations

- **`pnpm db:drill <env>`** runs `wrangler d1 export` of the environment's database into a scratch local D1. It applies the repository's pending migrations there, runs `PRAGMA foreign_key_check` and `PRAGMA integrity_check`, and runs a row-count and invariant report. It never writes to the source database.
- **Migration test.** A DB test applies migrations 0000…N−1, seeds representative rows through the domain shapes of that time (fixtures under `packages/db/test/fixtures/at-NNNN.sql`), then applies N…latest and checks constraints. Every future migration adds a fixture.
- **Runbooks:**
  - `incident-response.md`: triage, alerts, access-loss incident, credential leak, Time Travel restore;
  - `failure-triage.md`: reading `/ops`, error codes, retry versus dismiss;
  - `alerting-setup.md`: Issues, the two Monitors, email;
  - `backup-and-restore.md`: the drill, a real restore and its order of operations;
  - `secret-rotation.md`: the table above, step by step.

### Security review

- **Stored payloads.** A test scans every table after the E2E-scale seed (all scenarios) for the canaries and for any email shape outside the claim request envelope.
- **Logs.** A test runs every job kind and page with canaries and scans the captured logs.
- **Review.** An adversarial review covers the operator routes, the export, the deletion flows, the DLQ consumer and the rotation flows. Findings are fixed or recorded in a threat model: `docs/security/operations-threat-model.md`, written in T1 with threats O1…On.

## Schema additions (migration 0009)

- **`workspaces`:** `status` gains `deleting` and `purging`; new columns `delete_after` and `deletion_requested_by`. A CHECK requires `delete_after` to be set exactly when the status is `deleting` or `purging`.
- **`outbox`:** `workspace_id` (nullable; composite foreign key where set), `dismissed_at`, `dismissed_by`, `dismiss_reason`. A CHECK: dismissed only when failed.
- **`github_connections`:** `rate_limited_until`.
- **`paddle_connections`:** `webhook_secret_next` (envelope), `notification_setting_next_id`.
- **`system_state`:** `key` primary key, `value` JSON, `updated_at`.
- **Triggers:** `audit_events` BEFORE DELETE is re-created with `WHEN (SELECT status FROM workspaces WHERE id = OLD.workspace_id) IS NOT 'purging'`.
- **Indexes:** `entitlements(state, valid_until)`, the open-failures index, the pending-outbox subject index, and retention indexes on `external_events(received_at)`, `outbox(sent_at)`, `claim_tokens(expires_at)`, `checkout_claims(expires_at)` and `provider_mutations(settled_at)`.

T1 writes the migration. The task notes record any change in shape from this list.

## Scenarios due by Phase 6

Already in `testing-strategy.md`:
- `timing/sweep-replay-is-idempotent` (renamed from `workflow/replay-is-idempotent`, decision 0013);
- `timing/stale-workflow-cannot-revoke-renewed`;
- `timing/renewal-during-scheduled-revocation` (entry-point test added);
- `timing/grace-expiry-revokes` (entry-point test added).

New:

| Scenario | Source | Layer |
|---|---|---|
| `timing/expiry-confirmed-before-revoke` | Decision 0013 | Domain, service |
| `timing/expiry-revokes-after-confirmation-window` | Decision 0013 | Domain, entry point |
| `timing/sweep-lag-alerts` | Decision 0014 | Entry point |
| `failure/exhausted-job-is-recorded-and-alerted` | Decision 0014 | Entry point |
| `failure/dead-letter-marks-row-failed` | Decision 0014 | Entry point |
| `failure/owner-sees-only-own-failures` | Decision 0014; isolation | Service, E2E |
| `operator/non-operator-gets-404` | Decision 0014 | Entry point |
| `operator/actions-audited` | Decision 0014 | Service |
| `crash/every-batch-boundary-converges` | Matrix: partial transaction and crash recovery | Service |
| `provider/timeout-is-retryable` | Matrix: provider outage | Contract, service |
| `retention/prune-keeps-referenced-rows` | Decision 0015 | DB, service |
| `deletion/workspace-revokes-before-purge` | Decision 0015 | Service, E2E |
| `deletion/audit-delete-only-while-purging` | Decision 0015 | DB |
| `deletion/account-revokes-and-removes-identity` | Decision 0015 | Service |
| `export/contains-no-secrets` | Decision 0015; AGENTS: secret leakage | Service |
| `rotation/old-and-new-secret-both-accepted` | Phase 6: credential rotation | Service, entry point |
| `partition/one-installation-cannot-starve-others` | Phase 6: partitioned reconciliation | Service |
| `migration/upgrade-from-each-release-keeps-data` | Phase 6: migration procedures | DB |
| `security/no-secrets-in-stored-rows-or-logs` | Phase 6 acceptance | Service, entry point |

## Tasks and parallelisation

Same method as Phases 2–5:
- the lead does T1;
- T2, T3, T4 and T5 run in parallel worktrees, each first merging `phase-6/hardening`;
- then T6;
- then T7.

```text
T1 decisions, migration 0009, vocabularies, config ──┬─ T2 timing: expiry confirmation, sweep health, partitioning ─┐
                                                     ├─ T3 failures: DLQ, failure services, /ops, owner view, alerts ┼─ T6 fault injection, security review ─ T7 E2E, runbooks, verification
                                                     ├─ T4 data lifecycle: prune, export, deletions                  │
                                                     └─ T5 rotation: keyrings, webhook secrets, rewrap job ─────────┘
```

### T1 — Migration, vocabularies, configuration (lead)

- Migration 0009 and the Drizzle schema, with the rebuild tests and the audit-trigger test.
- **Vocabularies:**
  - workspace statuses;
  - outbox kinds `prune_data`, `purge_workspace` and `rewrap_credentials`;
  - entitlement end reasons;
  - the alert names;
  - the audit action names (definitions in each owning task): `job.failed`, `job.retried`, `job.dismissed`, `operator.viewed_workspace`, `data.pruned`, `workspace.exported`, `workspace.deletion_requested`, `workspace.deletion_cancelled`, `workspace.purged`, `user.deleted`, `paddle.webhook_secret_rotated`, `credentials.rewrapped`.
- Placeholder `runJob` cases.
- Env schemas and wrangler config: `OPERATOR_GITHUB_IDS`, the DLQ and its consumer, Issues, `GITHUB_WEBHOOK_SECRET_PREVIOUS`, and the `CLAIM_SIGNING_KEY` keyring format (accepting the old single-key format).
- `dedupedOutboxInsert` takes a workspace ID, and every caller passes one.
- The scenario rows in `testing-strategy.md`, and `docs/security/operations-threat-model.md`.

### T2 — Timing (parallel)

- The three-way planner filter and the `nextReconcileAt` window check, with property tests.
- The access-page label for expiry pending.
- Heartbeat and lag alert, using `system_state`.
- Partitioned daily jobs; the per-installation reconcile cap; `rate_limited_until`.
- Entry-point tests: `timing/stale-workflow-cannot-revoke-renewed`, `timing/sweep-replay-is-idempotent`, `timing/renewal-during-scheduled-revocation`, `timing/grace-expiry-revokes`, `timing/sweep-lag-alerts`, `partition/one-installation-cannot-starve-others`.

### T3 — Failures and operator (parallel)

- DLQ consumer; `job.failed` on every terminal failure.
- Failure services with affected-access resolution; retry and dismiss.
- The `requireOperator` principal; `/ops` and its read-only workspace view; the owner failure list on the Access page.
- The alert helper, and alert lines at every condition in decision 0014.
- Tests: the `failure/*` and `operator/*` scenarios.

### T4 — Data lifecycle (parallel)

- `prune_data`, `purge_workspace`; the request, cancel and purge services; account deletion.
- The export builder with the secrets scan.
- Pages: workspace settings (export, delete), `/me` (delete account).
- Tests: the `retention/*`, `deletion/*` and `export/*` scenarios.

### T5 — Rotation (parallel)

- `CLAIM_SIGNING_KEY` keyring; `GITHUB_WEBHOOK_SECRET_PREVIOUS`.
- Paddle webhook secret rotation (service, billing action, fake Paddle support).
- `rewrap_credentials` job.
- Tests: `rotation/old-and-new-secret-both-accepted`, and rotation failure at each step.

### T6 — Fault injection and security review (after T2–T5)

- The crash-at-batch-N helper and the `crash/every-batch-boundary-converges` matrix.
- The hang fault and `provider/timeout-is-retryable`.
- The outage-window tests.
- The stored-row and log scans (`security/no-secrets-in-stored-rows-or-logs`).
- The migration upgrade test with fixtures.
- An adversarial review of the new surfaces. Fix findings or record them in the operations threat model.

### T7 — E2E, runbooks, verification

- **E2E journeys:**
  - owner sees a failed job and retries it;
  - operator resolves a failure on `/ops`;
  - a non-operator gets 404 on `/ops`;
  - owner exports a workspace;
  - owner deletes, then cancels deletion;
  - user deletes their account;
  - a renewal webhook lost before the boundary keeps access.
- `pnpm db:drill` and the five runbooks.
- Update `deployment.md` (DLQ, Issues, operator IDs), `architecture.md`, `domain-model.md`, `integrations.md` and `testing-strategy.md`. Amend decision 0009 per 0013.
- Set `CURRENT_PHASE` to 6. Run the full gate: lint, typecheck, `db:check`, `test:coverage`, `check:scenarios --phase 6`, E2E, and domain mutation on the final commit.

## Acceptance criteria

From `implementation-plan.md`, with how each is met:

| Criterion | How it is met |
|---|---|
| Workflow replay/retry is idempotent | No Workflows (decision 0013). Sweep replay and queue redelivery are idempotent (`timing/sweep-replay-is-idempotent`, `queue/redelivery-is-idempotent`). |
| A stale delayed workflow cannot revoke a renewed subscriber | Expiry confirmation (`timing/stale-workflow-cannot-revoke-renewed`). |
| Exhausted failures are visible, actionable, and correlated to affected access | Failure rows, owner and operator pages with retry, and email alerts (`failure/*`). |
| Scheduled reconciliation repairs missed events and external drift | Existing sweeps, now partitioned and observed (`partition/*`, `provider/outage-recovers-on-scheduled-reconcile`). |
| Backup/restore and migration procedures are tested for D1 | `db:drill`, the upgrade test, and the runbooks (`migration/*`). |
| Security review finds no secrets in logs, audit details, or stored raw payloads | Scans and review (`security/no-secrets-in-stored-rows-or-logs`). |

## Implementation notes

Where the build differs from, or adds to, the design above.

### T1

- **Migration 0009** (`0009_operational_hardening.sql`) is as planned, with these differences:
  - **Rebuilds.** Changing the `workspaces` status CHECK and adding CHECKs to `outbox` and `paddle_connections` rebuilds those three tables. `workspaces` and `paddle_connections` are referenced by other tables, and D1 runs a migration in a transaction where drizzle-kit's `PRAGMA foreign_keys=OFF` does nothing, so the DROP failed on a populated database. The migration uses D1's `PRAGMA defer_foreign_keys` instead. drizzle-kit also selected the new columns from the old tables; the copies select `NULL` for them. `hardening-migration.test.ts` upgrades a populated 0008 database: rows, references (`PRAGMA foreign_key_check`), indexes and triggers all survive. Earlier rebuild tests now expect the outbox's new columns.
  - **Names.** The GitHub table is `connections`, so the column is `connections.rate_limited_until`. The Paddle columns are `destination_next_id` and `webhook_secret_next_envelope`, after the existing `destination_id` and `webhook_secret_envelope`, rather than `notification_setting_next_id` and `webhook_secret_next`.
  - **Paddle CHECKs.** The next secret must be a JSON object and needs its destination (`paddle_connections_next_secret_has_destination`). Disconnecting erases it too (`paddle_connections_disconnected_erased`).
  - **Deletion columns.** `delete_after` and `deletion_requested_by` are set exactly while the workspace is `deleting` or `purging` (two CHECKs). `deletion_requested_by` is a user ID without a foreign key, like an audit actor: the requester may delete their account during the 30 days.
  - **Outbox columns.** `outbox.workspace_id` is a plain foreign key to `workspaces(id)`, not a composite one: a row's subject differs by kind, so no single table can be referenced. The outbox is exempt from the tenant-key conformance check, like `audit_events`. `dismissed_by` has no foreign key, for the same reason as the requester. A dismissal needs `failed_at`, `dismissed_by` and a non-empty `dismiss_reason` (CHECKs).
  - **Triggers beyond the plan** ([decision 0015 amendment](../decisions/0015-data-lifecycle.md#amendment--the-other-append-only-tables-and-the-way-into-purging-phase-6-t1)):
    - `offer_versions_no_delete` gets the same `purging` exception as the audit trigger.
    - `provider_mutations_no_delete` also lets settled rows be pruned.
    - `workspaces_purging_one_way` and `workspaces_created_live` make `purging` reachable only from `deleting`, and final.
  - **Retention indexes.** `outbox(sent_at)` is not added: `outbox_pending_idx (sent_at, available_at)` already leads with it. `provider_mutations` has `finished_at`, not `settled_at`, so the index is `provider_mutations_finished_idx`. `claim_requests_created_idx` is added for pruning claim requests. The Better Auth `auth_sessions` and `auth_verifications` tables still have no `expires_at` index; T4 adds them if pruning needs them.
- **Outbox rows carry their workspace.** `NewOutboxRow` requires `workspaceId` (string or null), so every insert path states it, not only `dedupedOutboxInsert`. Every caller passes its key's workspace. Received GitHub webhooks pass null, because their workspace is known only once they are processed. Received Paddle webhooks pass their connection's workspace.
- **Vocabularies** (`packages/domain`):
  - `WORKSPACE_STATUSES` gains `deleting` and `purging`. Existing code tests `status !== "active"`, so both statuses already refuse writes, checkout and claims like `suspended`. No switch over workspace status exists. T4 makes the remaining behaviour explicit (pages, the cancel path).
  - `OutboxKind` gains `PruneData`, `PurgeWorkspace` and `RewrapCredentials`.
  - `ACCESS_DECISION_REASONS` gains `workspace_deleted` and `account_deleted`. Both are revocations (`revoked`), with Access-page texts.
  - `ALERT_NAMES` and `AlertName` are in `alert.ts`.
  - The audit actions have minimal, strict details (IDs, counts and codes). The owning tasks refine them. `job.failed`, `job.retried` and `job.dismissed` use a new catalog scope, `either`: the caller passes the workspace ID, or an explicit null for system-wide work, which makes the event account-scoped. `job.dismissed` requires a reason. `data.pruned`, `workspace.purged`, `user.deleted` and `credentials.rewrapped` are account-scoped, with per-table counts keyed by table name.
- **Jobs.** The three new kinds fail for good with `not_implemented` (`JobRejection.NotImplemented`) until T4 and T5 add them. The jobs Worker consumes `sharerepo-events-dlq-<env>`. For now it acknowledges each dead-lettered message and logs its message ID only (`DEAD_LETTER_QUEUE_PREFIX`). T3 replaces this.
- **Configuration:**
  - `OPERATOR_GITHUB_IDS` is a var on the web Worker only, empty in every environment. `parseOperatorGitHubIds` (`packages/platform`) fails closed on anything but comma-separated numeric IDs. `WebEnv.operatorGitHubIds` exposes the result. Production sets it by editing `apps/web/wrangler.jsonc`: the IDs are not secret. The jobs Worker has no use for it.
  - Workers Issues is on in every environment of both Workers.
  - `GITHUB_WEBHOOK_SECRET_PREVIOUS` is an optional secret. It is parsed into `GitHubAppConfig.webhookSecretPrevious` and is not used yet (T5).
  - `CLAIM_SIGNING_KEY` accepts the Phase 5 plain-text key or a JSON keyring `{"current","keys"}` of base64 keys of at least 32 bytes. `CommerceSecrets.claimSigningKeys` holds the keyring. `claimSigningKey` is still the current key, so signing is unchanged. A plain-text key becomes key ID `single`.
- **Threat model.** [operations-threat-model.md](../security/operations-threat-model.md) has threats O1–O19. Three new scenarios come from it: `deletion/purging-is-one-way` (done in T1), and `deletion/purge-touches-only-its-workspace` and `deletion/cross-site-request-refused` (T4).
- **For T2–T5:**
  - **T2:** use `entitlements_state_valid_until_idx` and `outbox_pending_subject_idx` for the repair queries. Store the lag alert's last time under a `system_state` key. `system_state` is listed as unaudited bookkeeping.
  - **T3:** `job.failed` takes the outbox row's `workspace_id`. Dismissal must set all three dismissal columns. Retrying a dismissed row must clear them (CHECK). Owner queries filter by `outbox.workspace_id`. Rows queued before 0009 have a null workspace and show only on `/ops`.
  - **T4:** set `purging` only from `deleting`, in the purge's first batch. Delete the outbox rows of the workspace before the `workspaces` row (foreign key). Started provider mutations can only be deleted while purging. The purged tombstone and `data.pruned` are account-scoped.
  - **T5:** `claim_requests.email_hash` and the claim rate-limit buckets are HMACs under the claim signing key. Rotating the key changes them, so lookups by email hash must try every key, or the rotation must wait out the claim windows. The e2e environment still uses the plain-text key format.

### T4

- **Migration 0010** (`0010_retention_indexes.sql`) adds only `auth_sessions_expires_idx` and `auth_verifications_expires_idx`, for pruning. A task that also generates a 0010 renumbers on merge.
- **Domain** (`lifecycle.ts`): the retention periods (`RETENTION_MS`), `pruneCutoffs`, `LIFECYCLE_BATCH_SIZE` (500), `WORKSPACE_DELETION_DELAY_MS`, `purgeDue`, `purgeBlock` and `PurgeBlock`, the confirmations, `workspacesBlockingAccountDeletion`, and `dailyOffsetMs` (FNV-1a of a key, mod 24 h). T2's partitioning hash can replace `dailyOffsetMs` if it lands one. `exportRateLimitBuckets` (`export:<workspaceId>:h`, 5 an hour) reuses the claim rate-limit table.
- **Withdrawn access.** `planEntitlements` takes an optional `withdrawn` reason: nothing is desired and every live entitlement is revoked with it. A refresh of a workspace that is `deleting` or `purging` does not read its source (its Paddle connection is gone): it plans from the stored facts with `withdrawn: "workspace_deleted"`.
- **Deletion request** (`requestWorkspaceDeletion`): confirmed by the exact slug. It first disconnects Paddle through `disconnectWorkspacePaddle`, now shared with `disconnectPaddle`. Without commerce configuration, or when Paddle cannot be asked, the credentials are still erased and the destination ID stays for the owner (`orphanedDestinationId`, shown on the page). Then one batch sets `deleting`, `delete_after` and the requester, writes `workspace.deletion_requested`, and queues a refresh of every subscription (one `INSERT … SELECT`, keyed as `encodeRefreshKey` keys them). The refreshes end the entitlements, which queues the reconciles. `openWorkspace` gains a `writableIn` option for the lifecycle pages.
- **Cancel** (`cancelWorkspaceDeletion`): `active` again, `workspace.deletion_cancelled`, and refreshes of the simulated subscriptions (and Paddle ones only while Paddle is connected, which it never is after a deletion). **`connectPaddle` now queues a refresh of every stored Paddle subscription**, so reconnecting after a cancel restores their access (decision 0015: "Paddle must be reconnected").
- **Batch guards.** A batch that follows a guarded UPDATE writes its first audit event only if `changes() = 1`, and its other statements only if that event exists (`afterUpdate`). Re-checking the row's new state would also match an identical earlier change.
- **Purge** (`purgeWorkspace`, job `purge_workspace` keyed by workspace ID):
  - It runs only when `purgeDue`. From `deleting` it first checks for live entitlements and managed grants. The first batch moves the workspace to `purging` under the same conditions, in SQL, so a race cannot start it early.
  - Then it empties `PURGE_ORDER` (every workspace-owned table, foreign-key order, Paddle connections' received events included, `audit_events` last) in batches of 500. An empty table costs a query, not a batch. After 40 batches it queues its own continuation, a plain insert: the running row is still pending, so a deduplicated insert would find itself.
  - Progress (rows per table) is kept in `system_state` under `purge_progress:<workspaceId>`, updated in the same batch as each delete through `changes()`. The tombstone's counts are therefore exact after any crash.
  - The last batch deletes any outbox row queued for the workspace meanwhile, the workspace, the progress, and writes the account-scoped `workspace.purged` only if the workspace row was deleted (`changes() = 1`). A row another job wrote meanwhile fails that batch on its foreign key; the purge queues a continuation.
  - The intermediate batches write no audit event of their own: they delete the workspace's history, and the tombstone records the counts.
  - `purge_workspace` and `prune_data` rows have no workspace (`workspace_id` null): a purge deletes its workspace's outbox rows, and the workspace row cannot go while one names it. Their failures show only on `/ops`.
- **How a blocked purge is surfaced (for T3 and T7).** A due purge that waits writes `system_state` key `purge_blocked:<workspaceId>`, value `{ "reason": "entitlements_remaining" | "managed_access_remaining", "since", "checkedAt" }`. `since` is kept while the reason stays the same. `getWorkspaceDeletionState(db, workspaceId).blocked` reads it, and the settings page shows it. The job ends with `JobOutcome.Waiting`. It logs `job waits for a precondition` with IDs only, and its outbox row is marked sent, not failed: the daily cron queues the purge again, so a failure row per day would only accumulate. With `entitlements_remaining`, the purge also queues the refreshes again (the repair path). The key is removed when the purge starts or the deletion is cancelled. **T3/T7:** show it on the owner's failure list and on `/ops`. A workspace whose owner uninstalled the GitHub App before the purge waits on `managed_access_remaining` for ever; the incident runbook needs an operator procedure for it.
- **Pruning** (`pruneData`, job `prune_data`, subject `retention`). Each table selects at most 500 keys, then one batch deletes them by key and writes `data.pruned` with exactly those counts. Differences from the decision's table:
  - `ignored` external events are pruned like processed ones. An event that a pending or failed outbox row still reads stays.
  - Only processed claim requests are pruned. An unprocessed one belongs to a pending or failed job.
  - Rate-limit counters go once their window started more than a day ago: the longest window is a day.
  - **Orphaned `users` rows** are pruned once nothing names them and they are over a day old (see account deletion).
- **Daily queueing.** `queueLifecycleJobs` queues one `prune_data` and a `purge_workspace` per due workspace, deduplicated and offset by `dailyOffsetMs`. It is called from the daily cron through `dailyLifecycle`, one added line.
- **Account deletion** (`deleteAccount`): confirmed by the GitHub login, ignoring case, and refused while the user owns a workspace that is not being deleted. Differences from the decision:
  - Per workspace, one batch unlinks the subjects (new workspace audit action `subject.identity_unlinked`). It also unlinks **the customers linked to them** (`customer.linked` to null), so old links do not come back on a later sign-in. It ends their live entitlements directly with `account_deleted` (`entitlement.ended`, not through the planner), and queues reconciles and refreshes of those customers' subscriptions. A refresh that read the old link then finds the customer unlinked and ends any entitlement it recreated.
  - The last batch deletes the user's checkout claims (used or not), claim requests, the claim tokens they consumed, connection intents, memberships, Better Auth sessions and accounts, identities, `auth_users`, and the `users` row, with `user.deleted` (counts only).
  - **The `users` row stays** while a `connections` or `offer_versions` row still names its ID as creator: their own `deleting` workspace, or another workspace's history. It holds no personal data, and pruning removes it once nothing names it.
  - The page clears the cookies through Better Auth's sign-out after the sessions are gone.
- **Export** (`exportWorkspace`, `POST /w/:slug/export`): built in memory on request, not streamed, which is enough at v1 sizes. Every table is read through an explicit column allow-list (`export-repository.ts`). Claims, claim requests and claim tokens are not exported. Members are listed with their GitHub login, and `offer_versions` snapshots and audit details are parsed JSON. The export is owner only, also while `deleting`, limited to 5 an hour (429 with `retry-after`), audited as `workspace.exported`, and sent as a `no-store` attachment without CORS headers.
- **Pages:**
  - workspace settings: rename, export, delete, cancel, and the deleting banner with the date, the wait reason and the instruction to uninstall the GitHub App;
  - `/me`: the GitHub login, the blocking workspaces, and delete account;
  - a read-only banner in the workspace layout, and an "Account" link in the header.
- **Tests:**
  - scenarios: `retention/prune-keeps-referenced-rows` (DB), `deletion/workspace-revokes-before-purge`, `deletion/purge-touches-only-its-workspace` and `deletion/account-revokes-and-removes-identity` (service), `export/contains-no-secrets` (service, with a canary, the stored envelope and hash values, and an email-shape scan), and `deletion/cross-site-request-refused` (routes);
  - `crash/every-batch-boundary-converges` for the purge and for account deletion: batch N fails before or after committing, then a re-run converges with one tombstone or one `user.deleted`;
  - E2E (`lifecycle.spec.ts`): export, delete then cancel, and account deletion. T7 extends them with revocation.
  - `deletion/audit-delete-only-while-purging` stays T1's DB test.

## Risks and open points

- **Monitors is a beta.** Alerting has a manual fallback, a daily `/ops` review, until it is stable.
- **The confirmation window.** The 6-hour confirmation window means a cancelled subscriber can keep access up to 6 hours past the boundary during a Paddle outage. Decision 0013 accepts this.
- **Deployment.** Live checks of DLQ routing and Issues email need a deployed environment. They are recorded in `deployment.md` as first-deploy checks.
- **Deferred checks.** The Phase 4 GitHub and Phase 5 Paddle live checks are still outstanding. Phase 7 cannot start without them.
