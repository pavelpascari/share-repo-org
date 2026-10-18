# Phase 3 plan — Entitlement core and simulated source

Source: `implementation-plan.md` § Phase 3. Policy decisions: [0009](../decisions/0009-entitlement-policy-v1.md). Segment: [0008](../decisions/0008-v1-personal-account-repositories.md), personal-account repositories with write access. Outbox: [0003](../decisions/0003-d1-batches-and-transactional-outbox.md).

## Goal

Prove the separation of subscription, entitlement and grant, and the reconciliation planner, without Paddle and without changing anyone's GitHub access. In a development workspace, a creator:

1. defines an offer (repositories plus commercial items, plus a grace period);
2. drives a simulated subscription through its lifecycle;
3. sees the desired access, the observed access (always "not checked yet" until Phase 4), and what the reconciler would do and why.

## Out of scope

- Any GitHub collaborator mutation or observation. Grants exist as a table and as planner input, but nothing writes them until Phase 4.
- Paddle, customers who pay before signing in, and purchase claims (Phase 5).
- Workflows. Time-based expiry uses a database-scheduled evaluation swept by cron (see Design). Phase 6 decides Workflows versus database timers.

## Design summary

### Commercial side

- **Offer.** Workspace-owned. It has:
  - a name;
  - a status (`active` or `archived`);
  - a `grace_period_days` value from 0 to 30, defaulting to 7 (decision 0009);
  - a current `version`;
  - its current commercial items and repository accesses.

  Every configuration change bumps the version and writes an immutable `offer_versions` snapshot in the same batch. That snapshot holds the name, grace period, items and accesses as validated JSON. An entitlement therefore always refers back to exactly what was promised when it was decided.
- **Commercial items.** Each one is `(source, external_item_id)`, for example `simulated:sim_monthly` (or later `paddle:pri_…`). An item maps to at most one offer in a workspace, enforced by a unique index.
- **Offer access.** Each one is `(resource, access_level)`.
  - An access level must be supported by the resource's capability snapshot (domain invariant 12). Personal repositories have `readOnlyGrant: false`, so the only level they support is `write`.
  - Only sellable resources can be added. A resource that later stops being sellable stays in the offer, but the planner blocks provisioning for it.
- **Subject.** A GitHub user principal, keyed by immutable GitHub user ID, with a login snapshot and an optional link to a ShareRepo external identity. Unique per `(workspace, provider, external_subject_id)`.
- **Customer.** A commercial identity in a source, with an optional `subject_id`.
  - A customer without a subject gets no entitlement. The access view shows the decision as "subscriber not linked".
  - In Phase 3 only the simulator sets `subject_id`: in a non-production workspace, the owner explicitly links the customer to a GitHub account, which counts as an explicit link (domain § Identity linking).
  - Phase 5 replaces this with the verified claim flow.
- **Subscription.** The normalized commercial facts:
  - `source` and `external_subscription_id`;
  - customer and items;
  - `normalized_state`: `trialing`, `active`, `past_due`, `paused`, `canceled` or `expired`;
  - `provider_state`;
  - the period start and end;
  - `cancel_at`, the scheduled effective cancellation;
  - `ended_at`, the effective end for `canceled` and `expired`;
  - `past_due_since`;
  - `source_updated_at`, the source's own timestamp for this snapshot.

  It also holds `next_evaluation_at` and a `version` used for optimistic concurrency.

### Entitlement source port and the simulator

- **Port.** The application defines `EntitlementSourcePort.refreshSubscription(workspace, externalSubscriptionId)`, which returns a normalized `SubscriptionSnapshot` or `not_found`. It is the Phase 3 slice of the integrations doc's `EntitlementSource`. Paddle implements the same port in Phase 5.
- **The simulated source** stands in for the provider.
  - It is backed by a workspace-scoped `simulated_subscriptions` table. That table plays the role of "Paddle's database", is never read by policy code, and is only ever read through the port.
  - It is available only when `ENVIRONMENT` is not `production`; the routes return 404 there. A config test guards production.
- **Simulator actions:**
  - create a subscriber, by GitHub login, resolved to an immutable ID through the GitHub App;
  - start a trial, activate, renew (advance the period), mark past due, recover, pause, resume;
  - schedule cancellation at period end, cancel now, expire, reactivate.

  Each action updates the simulated source state with a new `updated_at`. In the same batch it writes an `outbox` row `refresh_subscription` and an audit event (`simulation.subscription_changed`), the way a webhook receipt would.

### Processing

Commercial events are hints. Processing always refreshes from the source.

1. `refresh_subscription` reads the current snapshot through the port.
2. It upserts customer and subscription **only if** `source_updated_at` is newer than the stored value. An equal or older snapshot is a no-op, so out-of-order and duplicate processing cannot regress newer state.
3. It recomputes entitlements for that subscription.
4. It writes everything (the subscription, entitlement changes, `next_evaluation_at` and audit events) in one batch. That batch is conditional on the subscription `version` read in step 2. A stale writer writes nothing and retries from fresh state, as resyncs already do.

### Policy and desired state (pure domain)

- **`decideAccess(subscription, offerVersion, now)`** returns `{ granted, validUntil, reason, nextEvaluationAt }`, per policy version 1 (decision 0009):

| Normalized state | Desired access |
|---|---|
| trialing, active | granted; `validUntil = cancel_at` if one is scheduled, otherwise open |
| past_due | granted until `past_due_since + grace_period_days` (or `cancel_at`, whichever is earlier) |
| paused | not granted (`paused`) |
| canceled | granted until `ended_at`; then not granted (`canceled`) |
| expired | not granted (`expired`) |

  `nextEvaluationAt` is the earliest future boundary, or null.
- **`planEntitlements(existing live entitlements for the subscription, desired accesses, now)`** is a deterministic diff. It returns a plan to create, update or end entitlements:
  - create a new entitlement;
  - update one: change its validity, its reason, or the offer version it refers to;
  - end one, as `expired` or `revoked`.

  One entitlement exists per `(subscription, offer, resource, subject)`. A partial unique index admits only one live row (`state = 'active'`). A reactivation after an entitlement ended creates a new row, so history stays readable.
- **Entitlement states:** stored as `active`, `expired` or `revoked`. "Pending" and "blocked" belong to the planner, not the entitlement, and "expiring" is simply an active entitlement with `valid_until` set. This narrows the domain model sketch, which says to keep the state set minimal; the domain model is updated accordingly.
  - **expired:** the validity interval ended (grace ran out, a cancellation took effect, the subscription expired).
  - **revoked:** the source stopped mapping it (the subscription was paused, the offer access was removed or archived, the customer was unlinked, the subscription disappeared).
- **Every entitlement records:**
  - its source: `source_type = 'subscription'`, `source_id`;
  - the `offer_id` and `offer_version`, and `policy_version`;
  - `valid_from` and `valid_until`;
  - `decision_reason`.
- **Offer changes:** editing or archiving an offer queues a `recompute_offer` outbox row. Its job recomputes every subscription carrying the offer's items, one subscription per outbox row.
- **Time:** the jobs cron runs every minute.
  - It claims subscriptions whose `next_evaluation_at` is at or before now, and queues `refresh_subscription`.
  - Re-evaluation re-reads the source, so a renewal that arrived while waiting wins (`timing/renewal-during-scheduled-revocation` is the Phase 5–6 scenario; the mechanism is here).
  - Between sweeps, the planner treats `valid_until <= now` as not desired, so access never outlives policy because a sweep is late.

### Grants and the reconciliation planner

- **Grant table**, created now:
  - workspace, connection, subject, resource and access level;
  - `state`: `unknown`, `absent`, `provisioning`, `pending_invitation`, `active`, `revoking` or `error`;
  - `managed`, true only for access ShareRepo created;
  - `entitlement_id`, nullable;
  - `external_grant_id`, `observed_at`, `last_attempt_at`, `last_error_code` and `retry_class`.

  Nothing writes it in Phase 3. A grant never creates or changes an entitlement (domain invariant 7).
- **`planReconciliation({ entitlements, grants, resources, connections, subjects, now })`** is pure. For each subject and resource it returns one decision with a reason code:

| Decision | When |
|---|---|
| `provision` | Desired, and the grant is absent or unknown, at a lower managed level, or an expired invitation (reissued). The resource must be sellable and the access level supported. |
| `verify` | Desired and the grant is active (periodic check); or the grant is stuck in `provisioning` or `revoking` (re-observe) |
| `wait` | Desired and an invitation is pending and not expired |
| `retry` | Desired, the grant is in a retryable error |
| `request_action` | Desired, and the grant error needs a user or the creator to act |
| `blocked` | A provider change is needed, but the resource is missing or not sellable, the connection is not active, the access level is unsupported by the capability, or the last error was terminal |
| `revoke` | Not desired and the grant is `managed` and active or pending |
| `noop` | Not desired, and the grant is absent or not managed. Unmanaged access is never revoked and is reported as such. |

### Creator views (repository-centric language)

- **Offers** (`/w/:slug/offers`): list, create and edit offers (name, grace period, repositories, commercial items), and archive. Shows the version.
- **Access** (`/w/:slug/access`): one row per subscriber and repository, with:
  - desired access: state, valid until, reason, subscription, offer and version, and policy version;
  - observed access: grant state ("Not checked yet" in Phase 3);
  - the planned action and its reason.
- **Simulator** (`/w/:slug/simulator`, non-production only): subscribers, subscriptions and lifecycle buttons, clearly labelled as simulated.

### Audit actions (new)

- `offer.created`, `offer.updated` (with the new version), `offer.archived`
- `subject.created`, `customer.created`, `customer.linked`
- `subscription.recorded`, `subscription.updated` (with state from and to)
- `entitlement.created`, `entitlement.updated`, `entitlement.ended` (`expired` or `revoked`, with reason)
- `simulation.subscription_changed`

`simulated_subscriptions` is source data, so its writes are audited with the simulation action. `outbox` remains exempt bookkeeping.

## Schema additions (one migration)

All tables except `outbox` are workspace-scoped, with composite foreign keys (decision 0004).

| Table | Notes |
|---|---|
| `offers` | Unique `(workspace_id, id)`. Columns: `name`, `status`, `grace_period_days` (CHECK 0–30), `version` (≥ 1), timestamps. |
| `offer_versions` | Primary key `(workspace_id, offer_id, version)`. Columns: `snapshot` (JSON, CHECK `json_valid`), `created_at`, `created_by`. Append-only via triggers, like audit. |
| `offer_items` | Unique `(workspace_id, source, external_item_id)`. Composite foreign key to the offer. |
| `offer_accesses` | Unique `(offer_id, resource_id)`. Composite foreign keys to the offer and the resource. `access_level` CHECK. |
| `subjects` | Unique `(workspace_id, provider, external_subject_id)`. Columns: `type`, `login_snapshot`, `external_identity_id` (nullable). |
| `customers` | Unique `(workspace_id, source, external_customer_id)`. Columns: `subject_id` (nullable composite foreign key), `display_name_snapshot`. |
| `subscriptions` | Unique `(workspace_id, source, external_subscription_id)`. Columns: state CHECK, `source_updated_at`, `next_evaluation_at` (indexed), `version`. |
| `subscription_items` | Unique `(subscription_id, external_item_id)`. |
| `entitlements` | Composite foreign keys to subject, resource, subscription and offer. Partial unique index on live rows. CHECKs on `valid_until > valid_from` and on states. |
| `grants` | Unique `(workspace_id, connection_id, resource_id, subject_id, access_level)`. CHECKs on states. |
| `simulated_subscriptions` | Workspace-scoped source data: customer GitHub ID and login, items JSON, state fields, `updated_at`. |
| `outbox` (changed) | Kinds gain `refresh_subscription` and `recompute_offer`. SQLite cannot alter a CHECK, so the table is rebuilt with its rows copied; this is tested from a populated 0003 database. |

## Tasks and parallelisation

Same method as before. The lead does T1; T2, T3 and T4 run in parallel worktrees; then T5; then T6 and T7 in parallel; then T8.

```text
T1 schema + migration + env ──┬─ T2 domain: policy, entitlement diff, planner, offers, audit ─┐
                              ├─ T3 integrations: GitHub user lookup + fake + contract ───────┼─ T5 application ─┬─ T6 web ──┐
                              └─ T4 db repositories ─────────────────────────────────────────┘                  └─ T7 jobs ─┴─ T8 E2E, model test, docs
```

### T1 — Schema, migration, configuration (lead)

- Drizzle schema for the tables above, migration `0004`, and the append-only triggers on `offer_versions`.
- The outbox rebuild migration, tested from a populated 0003 database.
- Domain constants that the CHECKs need: states, sources, access levels, outbox kinds.
- The simulator is available only when `ENVIRONMENT` is not `production`; a test asserts the production config.

### T2 — Domain (parallel)

- `ACCESS_LEVELS` and `supportsAccessLevel(capabilities, level)`.
- `parseOfferInput`: name, grace period from 0 to 30, unique items and accesses.
- `SubscriptionSnapshot` and its states; `isNewerSnapshot`.
- `decideAccess`, `planEntitlements` and `planReconciliation`, plus `ACCESS_POLICY_VERSION = 1`.
- The audit actions.
- Property tests:
  - computing desired state is deterministic and idempotent;
  - applying snapshots in any order with duplicates equals applying the newest one;
  - no decision revokes unmanaged access;
  - an entitlement's interval is never inverted.
- Scenarios at the domain layer:
  - `timing/cancellation-revokes-at-effective-time`
  - `timing/past-due-within-grace-keeps-access`
  - `timing/grace-expiry-revokes`
- 100% coverage and mutation score.

### T3 — Integrations (parallel)

- `getUserByLogin(login)` with an installation token, returning the immutable ID and the login.
- Support in the fake and the E2E fake server, and a contract-suite case.
- Pagination does not apply.

### T4 — Database repositories (parallel)

- **Offers:** create, update and archive, each with a version snapshot plus audit in one batch, conditional on the expected version.
- Subjects: upsert by external ID.
- Customers: upsert and link.
- **Subscriptions:** `applySubscriptionRefresh`, one conditional batch writing the subscription, items, entitlement plan and audit, which returns `stale` when another writer got there first.
- Entitlements: queries by subscription and by workspace.
- Grants: queries.
- Simulated source: get and update, with outbox and audit in one batch.
- Due-evaluation claim.
- Conformance, isolation and composite foreign key tests for every new tenant table.

### T5 — Application services (after T2–T4)

- **Offers:** `createOffer`, `updateOffer`, `archiveOffer` (`workspace.manage`), `listOffers`.
- **Simulator:** `createSimulatedSubscriber`, `simulateSubscriptionAction` (non-production only, `workspace.manage`).
- **Processing:** `refreshSubscription` (port, conditional write, at most 3 retries on `stale`), `recomputeOffer`, `queueDueEvaluations`.
- **Access view:** `listAccess` (desired, observed and planned, scoped to the workspace).
- Scenarios:
  - `webhook/out-of-order-does-not-regress`
  - `crash/between-event-commit-and-enqueue`, where the queue send fails after commit and the outbox drain recovers
  - the timing scenarios at the service layer, with a controllable clock
  - isolation for every new read and write
  - audit completeness for every new service

### T6 — Web (after T5)

- Offers, access and simulator routes, with same-origin POSTs and permission checks.
- Navigation entries. Copy says "repository" and "subscriber" throughout.

### T7 — Jobs (after T5)

- Outbox handlers for `refresh_subscription` and `recompute_offer`.
- A per-minute sweep of due evaluations.
- Queue message schema additions.
- Entry-point tests: redelivery stays idempotent, and a stale write retries.

### T8 — E2E, model test, docs, verification

- **E2E:**
  - an owner creates an offer for a repository;
  - the owner simulates a subscriber, activates, and sees desired access with the planned action "provision";
  - the owner cancels now and sees access ended;
  - a member cannot edit offers.
- **Model-based convergence test (first slice):**
  - commands: subscription lifecycle, duplicate or reordered refreshes, offer edits, clock advances, and crashes between commit and enqueue;
  - invariants: workspace isolation, entitlement provenance, audit completeness, and replay determinism (rebuilding from the latest snapshots yields the same live entitlements).
- **Docs:**
  - domain model updates (entitlement states, customer link in Phase 3);
  - `local-setup.md` (the simulator);
  - the decision 0009 status.
- CI moves to `CURRENT_PHASE: 3`.

## Acceptance criteria

| Criterion | Proven by |
|---|---|
| A simulated subscription can create, extend, expire and remove entitlements | T5 services, T8 E2E |
| Reprocessing the same facts produces the same durable result | Idempotency property tests (T2), duplicate refresh scenario (T5), model test |
| Out-of-order facts do not regress newer authoritative state | `webhook/out-of-order-does-not-regress` (T5), snapshot ordering property (T2) |
| Planner tests cover provision, revoke, no-op, pending, error and unsupported capability | `planReconciliation` tests (T2) |
| Every entitlement points to its source and policy version | NOT NULL columns and foreign keys (T1), model-test invariant (T8) |
| UI language remains repository-centric | T6 copy, E2E assertions |

## Risks and open points

- **Grace start time.** Paddle may not report when a subscription became past due. Phase 5 will either derive it from the first observed `past_due` refresh or use Paddle's transaction data. Policy only needs `past_due_since`.
- **Per-minute sweep.** This is sufficient at private-beta scale, and Phase 6 may replace it with Workflows.
- **Subject from a login.** A GitHub login is resolved to an immutable ID once, at link time. A later rename only updates the snapshot.
