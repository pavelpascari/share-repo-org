# Phase 4 plan — GitHub provisioning and reconciliation

Source: `implementation-plan.md` § Phase 4. Decisions:
- [0010](../decisions/0010-grant-ownership-and-reconciliation.md): ownership, per-repository reconciliation, and the spike assumptions.
- [0008](../decisions/0008-v1-personal-account-repositories.md): personal repositories, write access.
- [0009](../decisions/0009-entitlement-policy-v1.md): the entitlement policy.
- [0003](../decisions/0003-d1-batches-and-transactional-outbox.md): the outbox.

Research: [github-personal-accounts.md](../research/github-personal-accounts.md).

## Goal

Make GitHub access converge to entitlements, using the simulated source. In a development workspace:

1. Activating a simulated subscriber invites their GitHub account to the offer's repositories, and the access page shows "Invitation sent".
2. Once the invitation is accepted, the next reconciliation shows the access as active.
3. Ending the subscription removes the collaborator, or cancels the pending invitation, but only if ShareRepo created it.
4. Removing the collaborator by hand on GitHub is detected and repaired while the subscription is live.
5. Pre-existing access is shown and left alone.
6. Failures are classified and visible, and a workspace owner can trigger "Check now" and "Retry".

## Out of scope

- Paddle, purchase claims, and subscriber-facing pages (Phase 5). Subscribers learn about the invitation from GitHub's email.
- A cross-workspace operator console. The workspace owner's access page carries the repair controls, because the first creator is also the operator.
- Workflows (Phase 6). Timing uses `next_reconcile_at` swept by the minute cron, like Phase 3's evaluations.
- Organization repositories and `member` webhooks (decision 0010).

## Design summary

### Grant lifecycle and ownership (decision 0010)

```text
          observe: not listed                  ShareRepo intends to invite
  absent ───────────────────▶ absent ─────────────────────────────▶ provisioning (managed)
                                                                      │ PUT 201 / observed invitation
                                                                      ▼
  active (managed) ◀──── observed collaborator ──── pending_invitation (managed, expires_at)
        │                                                   │
        │ not entitled: intent recorded                     │ not entitled: intent recorded
        ▼                                                   ▼
  revoking (managed) ── DELETE collaborator / DELETE invitation ──▶ observe: not listed ──▶ absent (managed cleared)
```

- **Observed before ShareRepo intends anything:**
  - a direct collaborator becomes an unmanaged `active` grant;
  - a collaborator listed only in the full list becomes unmanaged, `active` and indirect;
  - a pending invitation becomes an unmanaged `pending_invitation`.
- **`managed` is set** only on the transition into `provisioning`. It carries through `pending_invitation` and `active` while observation keeps finding the access.
- **`managed` is cleared** when a grant becomes `absent`.
- **Errors:** a mutation that fails moves the grant to `error`, with `last_error_code`, `retry_class` and `next_attempt_at`, and keeps `managed` as it was.
- **Lost responses:** a lost response or a crash leaves the grant in `provisioning` or `revoking`. The next run's observation resolves it:
  - an observed invitation or collaborator for `provisioning` becomes managed `pending_invitation` or `active`;
  - nothing observed for `revoking` becomes `absent`;
  - nothing observed for `provisioning` means the PUT never landed, so the planner provisions again.
- **Only the workspace's subjects get grants.** Collaborators who are not subscribers are not stored.

### Reconciliation job (`reconcile_resource`)

- **Outbox key:** `<workspaceId>:<resourceId>`. An enqueue is skipped when an unsent, unfailed row with the same key exists, as for Phase 3's repair sweep.
- **Callers that enqueue:**
  - `applySubscriptionRefresh`, in the same batch, for every resource whose entitlements it creates, updates or ends;
  - resync, when a resource's selection, privacy, archive state or connection status changes;
  - the owner's "Check now" and "Retry";
  - the minute sweep of due resources.
- **`reconcileResource(ctx, key)`:**
  1. **Lease.** A conditional update sets `reconcile_token` and `reconcile_lease_until` (now + 2 minutes) only if no other lease is live. If another lease is live, the run returns `busy`, and the job succeeds without doing anything. The lease holder re-checks before releasing. Every grant write is guarded on the token, as Phase 2's resync guards on `sync_token`.
  2. **Load**, scoped to the workspace: the resource, its connection, live entitlements for the resource, grants, the subjects involved, and the invitation budget.
  3. **Observe** when the connection is active and the resource is selected:
     - `listCollaborators(direct)`, `listCollaborators(all)` and `listInvitations`, all paginated;
     - the pure `observeGrants` turns them into grant changes, matching people by immutable GitHub user ID;
     - grant changes and their audit events are written in one batch.
     
     When the connection is inactive or the resource is unselected, nothing is observed and the planner blocks.
  4. **Plan** with `planReconciliation`, extended below.
  5. **Act** on at most 10 decisions per run, in subject order.
     - Each provider change follows the same sequence:
       1. write-ahead: the grant moves to `provisioning` or `revoking`, a `provider_mutations` row is written with status `started`, and `provider.mutation_attempted` is audited, all in one batch;
       2. call GitHub;
       3. record the result: the grant state, the mutation's `succeeded` or `failed` status, and the audit event.
     - **Provision:** re-resolve the login from the user ID (`getUserById`), updating `login_snapshot` if it changed. If an expired managed invitation exists, cancel it first. Then `addCollaborator`.
     - **Revoke:** for an active grant, `removeCollaborator`; for a pending one, `cancelInvitation`.
     - **Stop early:** a `rate_limited` or `suspended` error stops the run. The resource's next run waits for `retryAfter`, or the connection is marked by the next resync.
  6. **Re-observe** if anything was mutated, and record the result.
  7. **Schedule and release:**
     - `next_reconcile_at` is now when decisions were left over;
     - otherwise the earliest of: 15 minutes if anything is pending, provisioning, revoking or in a retryable error; a pending invitation's `expires_at`; the end of a spent invitation budget; or 6 hours.
     - `last_reconciled_at` is set, and the lease is released.
- **Errors from GitHub (`GitHubApiError`) → grant error:**

| kind | grant `retry_class` | `last_error_code` | backoff |
|---|---|---|---|
| `transient` | `retryable` | `provider_unavailable` | 1, 5, 15, 60 minutes (by attempt), then 60 |
| `rate_limited` | `rate_limited` | `rate_limited` | `retryAfter`, minimum 1 minute |
| `rejected` 422 on invite | `user_action_required` | `invitation_rejected` (blocked, spam-flagged or invalid account) | none: "Retry" by the owner |
| `rejected` 403 | `user_action_required` | `app_permission_missing` (Administration: write not granted) | none |
| `not_found` on invite | `user_action_required` | `account_not_found` (account deleted) | none |
| `not_found` on repository | — | the resource is re-synced (`resync_connection` queued), and the grant is unchanged | next run |
| `suspended` | — | the run stops; the planner blocks with `connection_inactive` after resync | — |
| `malformed_response` | `retryable` | `provider_unavailable` | as `transient` |

  A `not_found` on removing a collaborator or cancelling an invitation means it is already gone: success.

### Domain changes

- **`planReconciliation`** gains:
  - `grant.nextAttemptAt`: an error not yet due is `wait` with its reason (`transient_error` or `rate_limited`), not `retry`;
  - `invitationBudget: { remaining, opensAt }` per resource: `provision` with no budget left is `wait` with the new reason `invitation_quota`;
  - `grant.indirect`: indirect access is `noop` with the new reason `indirect_access` when not desired, and `verify` with `grant_active` when desired;
  - a managed grant in `error` that is no longer desired is `revoke` if the error came from provisioning and an invitation may exist. The next observation decides.
- **`observeGrants(existing, observation, subjects, now)`**, pure, returns the grant changes. It implements the lifecycle above, including the lost-response resolutions.
- **`classifyMutationFailure(operation, error)`**, pure. It implements the table above, using a provider-neutral error shape.
- **`nextReconcileAt(grants, budget, now, leftover)`**, pure.
- **`invitationBudget(mutations, now)`**, pure: 40 per rolling 24 hours, counting `started`, `succeeded` and unknown invitations.
- Every rule gets property tests:
  - observation never sets `managed` without a prior `provisioning` intent;
  - no decision revokes unmanaged or indirect access;
  - applying the same observation twice changes nothing.
- 100% coverage and mutation score.

### GitHub port additions (`packages/integrations`)

```ts
listCollaborators(installationId, repo: string, affiliation: "direct" | "all"): Promise<GitHubCollaborator[]>   // { id, login, permission: "read" | "write" | "admin" }
listInvitations(installationId, repo: string): Promise<GitHubInvitation[]>   // { id, inviteeId, inviteeLogin, createdAt, expired }
addCollaborator(installationId, repo: string, login: string): Promise<{ outcome: "invited"; invitationId: string; createdAt: Instant } | { outcome: "already_collaborator" }>
removeCollaborator(installationId, repo: string, login: string): Promise<"removed" | "not_found">
cancelInvitation(installationId, repo: string, invitationId: string): Promise<"cancelled" | "not_found">
getUserById(installationId, id: string): Promise<GitHubUser>
```

- `repo` is the `owner/name` snapshot. Every value placed in a URL is validated first, as in Phase 2. A rename makes repository calls `not_found`, which triggers a resync.
- Pagination: 100 per page, following `Link: rel="next"`, capped at 30 pages. A longer list is an error, never silently truncated.
- Zod schemas validate every response, with recorded, redacted fixtures.
- **The fake** gains collaborators and invitations per repository, with controls for the test journeys:
  - accept an invitation, expire it, or remove a collaborator by hand;
  - inject a failure kind for the next call to an operation;
  - "succeed but lose the response";
  - record each call, so tests can assert that nothing was sent.
- The contract suite runs the same cases against the client, through recorded HTTP, and against the fake.
- **E2E fake server:** the same endpoints, plus test-only routes for accepting invitations and removing collaborators.

### Access view and controls

- **Observed column**, one of:
  - "Not checked yet";
  - "Invitation sent, waiting for @login to accept (expires 25 Oct)";
  - "Invitation expired";
  - "Active";
  - "Removed";
  - "Has access ShareRepo does not manage";
  - "Has access as the repository owner" (indirect);
  - "Error: …", with the plain-language error, a "what to do" hint, and when it will be retried;
  - "Checked 5 min ago", always shown.
- **Planned column:** the Phase 3 messages, plus the new reasons, "Waiting: invitation limit reached, resumes 14:05" and "Waiting to retry at 14:05".
- **Controls**, for workspace owners only (`workspace.manage`), each audited as `reconciliation.requested` with the actor:
  - "Check now" per repository queues `reconcile_resource` and sends it on the queue at once;
  - "Retry" per row with an error resets `next_attempt_at` to now (and the retry class for `user_action_required` or `terminal`) and queues reconciliation.
- A member sees the page without the controls.

### Audit actions (new)

- `grant.observed`: on state, managed or access-level change only, with from and to.
- `provider.mutation_attempted`, `provider.mutation_succeeded` and `provider.mutation_failed`, with the operation, mutation ID, error code and retry class. Never tokens or response bodies.
- `provider.mutation_resolved`: a `started` mutation whose outcome was settled by observation (a lost response).
- `reconciliation.requested`, from "Check now" or "Retry".

Every mutation row and audit event carries the job's correlation ID, the entitlement IDs behind the decision, and the resource's and subject's external IDs (integrations.md § Reconciliation ownership).

## Schema additions (migration 0005)

| Table | Change |
|---|---|
| `grants` | Adds `indirect` (boolean, default false) and `next_attempt_at`. The existing `grants_error_classified` CHECK already ties `error` to `last_error_code` and `retry_class`, so no rebuild is needed. `external_grant_id` holds the invitation ID while one is pending. |
| `resources` | Adds `next_reconcile_at` (indexed), `last_reconciled_at`, `reconcile_token` and `reconcile_lease_until`. |
| `provider_mutations` (new) | Workspace-scoped, with composite foreign keys to the grant, resource and subject. Columns: `connection_id`, `operation` (CHECK: `invite`, `remove_collaborator` or `cancel_invitation`), `access_level`, `status` (CHECK: `started`, `succeeded`, `failed` or `resolved`), `error_code`, `retry_class`, `external_id`, `entitlement_ids` (JSON), `correlation_id`, `started_at` and `finished_at`. Indexed on `(workspace_id, resource_id, operation, started_at)` for the invitation budget. Status changes once, from `started`; a trigger forbids other updates and all deletes. |
| `outbox` | Kind `reconcile_resource`. The table is rebuilt again with its rows copied, tested from a populated 0004 database. |

`ALTER TABLE … ADD COLUMN` is safe on a running service. Only the outbox rebuild copies rows, as in Phase 3.

## Scenarios due by Phase 4

All of these come from `testing-strategy.md`, which `pnpm check:scenarios --phase 4` enforces.

| Scenario | Where |
|---|---|
| `isolation/job-without-workspace-scope-rejected` | Jobs: a `reconcile_resource` key that does not decode, or names another workspace's resource, is rejected |
| `queue/redelivery-is-idempotent` | Jobs: the same message twice, and concurrently (lease), sends one invitation |
| `provider/mutation-succeeds-response-lost` | Application: the fake succeeds and loses the response; the next run resolves it without a second invitation |
| `crash/between-mutation-and-observation` | Application: the run fails after the write-ahead and the call; the next run resolves it |
| `crash/between-event-commit-and-enqueue` | Already covered in Phase 3; extend it to `reconcile_resource` |
| `identity/unlink-relink-moves-subject-safely` | Application: a customer relinked to another subject revokes the old subject's managed grant and provisions the new one |
| `resource/selection-removed-blocks-new-provisioning` | Application: no invitation, and the planner reports `resource_unavailable` |
| `connection/suspended-installation-surfaces-error` | Application: a `suspended` error stops the run, and the access page reports it |
| `invitation/pending-is-not-active` | Domain and application |
| `invitation/expired-is-reissued-or-surfaced` | Application: the lapsed managed invitation is cancelled and reissued within budget |
| `provider/rate-limit-backs-off-and-retries` | Contract and application: `retryAfter` is honoured, and the invitation budget defers |
| `provider/transient-error-retries` | Application: backoff schedule |
| `provider/outage-recovers-on-scheduled-reconcile` | Application and jobs: after an outage, the minute sweep converges |
| `drift/manual-removal-is-repaired` | Application and E2E |
| `drift/unmanaged-access-is-not-revoked` | Domain property, application and E2E |
| `drift/indirect-access-reported-accurately` | Application: the owner as subject is `indirect` and never touched |

## Tasks and parallelisation

Same method as Phases 2–3:
- the lead does T1;
- T2, T3 and T4 run in parallel worktrees, each of which **first merges `phase-4/provisioning`**;
- then T5;
- then T6 and T7 in parallel;
- then T8.

```text
T1 schema + migration + vocabularies ──┬─ T2 domain: observation, planner, classification, scheduling ─┐
                                       ├─ T3 integrations: collaborators, invitations, fake, contract ──┼─ T5 application ─┬─ T6 web ──┐
                                       └─ T4 db: grants, leases, mutations, budget, triggers ──────────┘                  └─ T7 jobs ─┴─ T8 E2E, docs, verification
```

### T1 — Schema, migration, vocabularies (lead)

- Migration 0005 and the Drizzle schema.
- The `provider_mutations` triggers.
- The outbox rebuild, tested from a populated 0004 database.
- `OutboxKind.ReconcileResource`, the mutation operation and status vocabularies, the new reconciliation reasons, and the vocabulary tests.

### T2 — Domain (parallel)

- `observeGrants`, `classifyMutationFailure`, `nextReconcileAt` and `invitationBudget`.
- The `planReconciliation` extensions.
- The audit actions.
- Property tests and the domain-level scenarios.
- 100% coverage and mutation score.

### T3 — Integrations (parallel)

- The six port methods in the client, with pagination and Zod response schemas.
- Fixtures: collaborators, invitations, the add-collaborator 201 and 204, and 422.
- The fake with its controls.
- The contract suite.
- The E2E fake server endpoints.

### T4 — Database repositories (parallel)

- **Leases:** `claimReconcileLease` and `releaseReconcileLease`.
- **Grants:** `applyGrantObservation`, a lease-guarded batch of grant upserts and audit events.
- **Mutations:** `beginMutation` (write-ahead: the grant state, the mutation row and audit) and `finishMutation`.
- **Budget:** `listRecentInvitations`.
- **Scheduling:** `scheduleReconcile`.
- **Outbox:** `enqueueReconcile` (deduplicated) and `claimDueReconciles`.
- `applySubscriptionRefresh` adds the reconcile outbox rows for touched resources.
- Conformance, isolation and composite foreign key tests for every new table and column.

### T5 — Application (after T2–T4)

- **Reconciliation:** `reconcileResource`; `requestReconcile` and `retryGrant` (owners only); and `queueDueReconciles`.
- **Triggers:** resync enqueues reconcile on resource or connection changes.
- **Access view:** `listAccess` shows the observed state, last check, retry time and controls permission.
- Service-level scenarios from the table above, isolation for every new read and write, and audit completeness.

### T6 — Web (after T5)

- Access page observed and planned copy, and the "Check now" and "Retry" POSTs, which are same-origin and owner-only.
- Copy says "repository", "subscriber" and "invitation".

### T7 — Jobs (after T5)

- The `reconcile_resource` handler, with the `busy` outcome.
- The minute sweep of due reconciles alongside due evaluations.
- Entry-point scenarios: redelivery, scope rejection, and outage recovery.

### T8 — E2E, model test, docs, verification

- **E2E against the fake GitHub:**
  - a subscriber is activated and invited, then accepts, and the access shows as active;
  - the subscription is cancelled now, and the collaborator is removed;
  - a pre-existing collaborator is left alone after cancel;
  - a manual removal is repaired after "Check now";
  - an injected rate limit shows "Waiting to retry".
- **Model-based convergence test (second slice):**
  - commands: entitlement changes, manual GitHub drift, lost responses, crashes between steps, duplicate jobs and clock advances;
  - invariants: GitHub converges to entitlements for managed access; unmanaged access is never removed; at most one live invitation per subject and repository; every mutation has an attempted and a final audit event.
- **Docs:**
  - `domain-model.md` (grant lifecycle, ownership), `integrations.md` (port, error table) and `local-setup.md` (fake controls);
  - the runbook: run the spike before merge, plus a live provisioning check (invite, accept, cancel) on the test repository;
  - `implementation-plan.md` resolves the ownership deferred decision.
- CI moves to `CURRENT_PHASE: 4`.

## Acceptance criteria

| Criterion | Proven by |
|---|---|
| An active simulated entitlement produces correct GitHub access for a real test repository | Fake-backed E2E. The live check needs a human: the runbook steps against the development App, before merge |
| An expired simulated entitlement removes only access ShareRepo manages | Domain property, `drift/unmanaged-access-is-not-revoked`, E2E |
| Duplicate jobs and lost responses do not create incorrect results | `queue/redelivery-is-idempotent`, `provider/mutation-succeeds-response-lost`, model test |
| Manual removal is detected and repaired; manual or pre-existing access follows the ownership policy | `drift/*` scenarios, decision 0010, E2E |
| Rate limits, permission failures, pending invitations and suspended installations are visible and classified | Classification table tests, access-page copy, scenarios |
| Every attempted and completed mutation has an audit trail | `provider_mutations` plus audit events, the model-test invariant, audit completeness tests |

## Risks and open points

- **Live behaviour.** The decision 0010 assumptions hold until the spike runs. The spike must run before this phase merges, and its answers may simplify the invitation handling.
- **Renamed repositories.** Calls use the `owner/name` snapshot. A rename between resyncs costs one failed run and a resync.
- **Subrequests.** A run makes at most 3 list calls (plus pages) and 10 mutations with their lookups, which is about 40 subrequests, within Workers limits. Very large repositories may need the cap lowered.
- **Invitation budget.** It counts only ShareRepo's invitations. If the creator sends many by hand, GitHub's own limit can still reject an invitation. That error maps to `rate_limited` when GitHub reports it as such, and otherwise to `invitation_rejected`.
- **A subscriber who is also the creator** has indirect owner access, so nothing is provisioned. The access page explains why.
