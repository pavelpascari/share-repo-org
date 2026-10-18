# Phase 2 plan — GitHub connection and feasibility proof

Source: `implementation-plan.md` § Phase 2. Target segment: [0008](../decisions/0008-v1-personal-account-repositories.md), personal-account repositories with write access. Outbox: [0003](../decisions/0003-d1-batches-and-transactional-outbox.md). Research: [GitHub personal accounts](../research/github-personal-accounts.md). Human setup: [GitHub App runbook](../runbooks/github-app-setup.md).

## Goal

A workspace owner installs the ShareRepo GitHub App on their personal account and sees the repositories they selected, kept current by signed webhooks and resyncs. A scripted live spike confirms the GitHub behaviour Phase 4 depends on.

## Out of scope

- Adding or removing collaborators. Phase 2 reads collaborator state only in the live spike; provisioning is Phase 4.
- Entitlements, offers and Paddle.
- Organization installations: refused at setup ([0008](../decisions/0008-v1-personal-account-repositories.md)).

## Prerequisites (owner: human)

Follow `docs/runbooks/github-app-setup.md`. Nothing here is needed for tests: everything runs against fakes.

- A development GitHub App on your personal account:
  - Repository **Administration: read and write** and **Metadata: read**;
  - the **Repository** webhook event;
  - Setup URL `…/github/setup` and webhook URL `…/webhooks/github`.
- Its App ID, slug, private key (converted to PKCS#8) and webhook secret, in `apps/web/.dev.vars` and `apps/jobs/.dev.vars`.
- A second GitHub account to act as a subscriber, and a private test repository on your account.
- For webhooks locally, a tunnel such as `cloudflared tunnel --url http://localhost:5173`.

## Design summary

- **New package `packages/integrations`**, holding GitHub only. It owns:
  - the App JWT (RS256 via WebCrypto) and installation tokens;
  - Zod schemas for every response and webhook payload used;
  - pagination, and error classification (`not_found`, `suspended`, `rate_limited`, `transient`, `rejected`);
  - webhook signature verification (HMAC-SHA256, constant-time, on the raw body).

  It exposes the `GitHubAppPort` used by application services. A fake implements the same port, and one contract suite runs against both the fake and recorded fixtures.
- **Installing is bound to an intent.**
  1. "Connect GitHub" (owner only, same-origin POST, write-access acknowledgement required) stores a `connection_intents` row: a hashed single-use token, workspace, user and expiry (15 minutes).
  2. It redirects to `https://github.com/apps/<slug>/installations/new?state=<token>`.
  3. GitHub sends the browser to `/github/setup?installation_id&setup_action&state`.
  4. The setup callback attaches the installation only when all of these hold:
     - the intent is valid, unexpired and unconsumed, and belongs to the signed-in user;
     - that user is still an owner;
     - the installation, fetched with the App JWT and never trusted from the query, is on a **User** account whose ID equals the user's linked GitHub ID;
     - the installation is not already attached to another workspace.

     Consuming the intent, creating the connection and writing the audit event are one batch. This is what proves the acceptance criterion "Installation callbacks cannot be attached to the wrong workspace."
- **Webhooks as hints** (architecture § Webhook and job reliability):
  - `/webhooks/github` in the web Worker verifies the signature before anything else.
  - It parses the envelope (event, delivery ID, installation ID, action).
  - In one batch, it inserts an `external_events` row (unique on `(provider, external_event_id)`; it stores metadata and a payload digest, not the payload) and an `outbox` row. Then it answers 202. A duplicate delivery answers 200 and writes nothing.
  - A best-effort `EVENTS` queue send follows. The jobs Worker consumes the queue, and also drains the outbox on cron as a safety net.
- **Processing resyncs; it never applies event diffs.** Any installation, installation-repositories or repository event for a known installation triggers `resyncConnection`. That service:
  1. fetches the installation (status, suspension, permissions) and its repositories with an installation token;
  2. upserts resources by immutable repository ID;
  3. marks unselected or missing ones `removed`;
  4. records changes, with audit events in the same batch.

  Duplicates, out-of-order deliveries and missed events therefore converge to GitHub's current state. A daily cron resyncs every active connection.
- **Resources:** `resources(workspace_id, id, connection_id, provider, type, external_id, name_snapshot, owner_external_id, private, archived, selection, capabilities, …)`.
  - Unique on `(connection_id, external_id)`, with a composite foreign key to `connections`.
  - A rename or transfer within the account updates snapshots in place; the ID stays.
  - A repository that leaves the installation becomes `selection = removed`, which Phase 4 treats as "block new provisioning, reconcile existing grants".
  - A repository can be sold only if it is private, not archived, selected, and its connection is active.
- **UI:** a workspace "Repositories" page. It shows the connection status (active, suspended or deleted) with clear next steps, and the repositories with their sellable state. The owner can start a connection and trigger a manual resync.

## Schema additions (one migration)

| Table | Notes |
|---|---|
| `connection_intents` | Workspace-scoped. Columns: `token_hash` (unique), `user_id`, `expires_at`, `consumed_at`, `write_access_acknowledged_at`. Composite foreign key to the membership. |
| `connections` | Workspace-scoped. Columns: `provider`, `installation_id` (unique globally), `account_external_id`, `account_login_snapshot`, `account_type`, `status` (active / suspended / deleted), `permissions` (JSON, validated), `write_access_acknowledged_at`, `last_synced_at`. Unique on `(workspace_id, id)`. |
| `resources` | As above. CHECKs on `type`, `selection` and `capabilities`. |
| `external_events` | Global: an event may arrive before any connection exists. Columns: `provider`, `external_event_id` (unique pair), `event_type`, `action`, `installation_id`, `received_at`, `payload_digest`, `processing_state`, `attempts`, `last_error_code`. |
| `outbox` | Global. Columns: `kind`, `payload_ref` (IDs only), `available_at`, `sent_at`, `attempts`. |

New audit actions:
- `connection.intent_created`
- `connection.created`, `connection.status_changed`
- `resource.discovered`, `resource.updated`, `resource.selection_changed`

`external_events` and `outbox` are system bookkeeping: excluded from the completeness helper with a reason, like Better Auth's sessions.

## Tasks and parallelisation

Same method as before.

```text
T1 deps + schema + migration + bindings ──┬─ T2 domain: connection/resource rules, capabilities, audit actions ─┐
                                          ├─ T3 integrations: JWT, tokens, client, webhook verify, fake, fixtures ┼─ T5 application services ─┐
                                          └─ T4 db repositories (intents, connections, resources, events, outbox) ┘                            │
                                             T6 spike script (live, outside CI) — after T3 ──────────────────────────────────────────────────┤
                                             T7 web: connect flow, setup callback, webhook endpoint, repositories page (after T5) ──────────┤
                                             T8 jobs: queue consumer, outbox drain, daily resync (after T5) ────────────────────────────────┤
                                             T9 E2E with fake GitHub App + docs + verification ──────────────────────────────────────────────┘
```

### T1 — Dependencies, schema, bindings (lead, serial)

- Create `packages/integrations`.
- One migration for the five tables.
- Bindings and config:
  - an `EVENTS` queue (producer: web; consumer: jobs);
  - secrets `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`, and vars `GITHUB_APP_ID` and `GITHUB_APP_SLUG`, for web and jobs;
  - the `e2e` env pointing the App API at the fake.
- Coverage scopes for the new package, at the 90% floor.

### T2 — Domain (parallel)

- Resource and connection rules:
  - `sellable(resource, connection)`;
  - capability snapshot for a personal account: `{ readOnlyGrant: false, maxInvitationsPerDay: 50, invitationExpiryDays: 7 }`.
- A pure diff: `planResourceSync(current resources, observed repositories)` → upserts, renames, removals.
- The new audit actions.
- Property tests: syncing is idempotent and order-independent.
- Keep 100% coverage and mutation score.

### T3 — Integrations (parallel)

- App JWT signing:
  - tested with a generated RSA key;
  - rejects a PKCS#1 key with a message pointing to the runbook conversion.
- Installation token minting.
- Requests: `getInstallation`, `listInstallationRepositories` (paginated), and the collaborator and invitation reads the spike needs.
- `verifyWebhookSignature` and the Zod payload schemas.
- An error classifier covering rate-limit headers.
- A fake GitHub App (in process, plus a Node server for E2E) and recorded fixtures. The contract suite runs on both the fake and the fixtures.
- Scenario `webhook/invalid-signature-rejected-before-persist`, at the contract layer.

### T4 — Database repositories (parallel)

- Intents: create and consume atomically, single use.
- Connections: create (unique installation), set status.
- Resources: apply a sync plan in one batch with audit events.
- External events: insert-if-new plus outbox in one batch, and mark processed or failed.
- Outbox: claim and mark sent.
- Conformance test with the new tenant tables, and isolation tests.

### T5 — Application services (after T2, T3, T4)

- `startGitHubConnection`, owner only, which records the acknowledgement.
- `completeGitHubConnection`, with the checks listed in the design summary.
- `ingestGitHubWebhook` and `processExternalEvent`.
- `resyncConnection`, `listRepositories` and `markConnectionDeleted`.
- Scenarios:
  - `webhook/duplicate-delivery-is-noop`
  - `resource/rename-transfer-keeps-identity`
  - `resource/selection-removed-blocks-new-provisioning`
  - `connection/suspended-installation-surfaces-error`
  - `connection/install-callback-bound-to-intent` (new; it covers a stolen state, another user, an org account, an installation already attached elsewhere, and an expired intent)
  - isolation for every new read and write;
  - audit completeness across every new service.

### T6 — Live feasibility spike (after T3; run by you)

`pnpm spike:github` runs `scripts/spike/github-feasibility.ts`, outside CI and coverage, against your App, test repository and subscriber account. It records each response in `docs/research/github-live-results.md`:

- what the `permission` parameter does on a personal repository;
- the 201/204 semantics;
- whether a collaborator DELETE on a pending invitee cancels the invitation;
- the invitation list fields, including `expired`;
- the repository and permission fields on the installation.

It cleans up after itself. A short manual checklist covers what a script can't: whether the `member` webhook reaches a personal installation, whether an invitation email arrives, and branch protection on your plan.

### T7 — Web (after T5)

- Routes:
  - `POST /w/:slug/github/connect`;
  - `GET /github/setup`;
  - `POST /webhooks/github`, which takes the raw body, has no session, is size-limited, and returns 202, 200 or 401;
  - `GET /w/:slug/repositories`;
  - `POST /w/:slug/repositories/resync`.
- Tests: the setup callback through the service against the fake App; the webhook endpoint (signature, size, duplicate, unknown event).

### T8 — Jobs (after T5)

- A queue consumer for `EVENTS`, with retry and backoff classification and dead-lettering to `processing_state = failed` plus a log line.
- Cron: drain the outbox every minute, resync all connections daily.
- Scenarios `queue/redelivery-is-idempotent` and `isolation/job-without-workspace-scope-rejected`, pulled forward from Phase 4, because the consumer exists now.

### T9 — E2E, docs, verification

- E2E against a fake GitHub App server:
  - an owner connects, is redirected back and sees repositories;
  - a member cannot connect;
  - a forged or replayed state is refused;
  - an organization installation is refused;
  - a webhook marks a repository removed after a resync.
- Docs: `local-setup.md` and `deployment.md` (secrets, queue creation), the integrations contract notes, and decision updates. CI moves to `CURRENT_PHASE: 2`.

## Acceptance criteria

| Criterion | Proven by |
|---|---|
| An authorized workspace member can install the app and see selected repositories | T9 E2E, T5 services |
| Installation callbacks cannot be attached to the wrong workspace | `connection/install-callback-bound-to-intent` |
| Duplicate installation webhooks are harmless | `webhook/duplicate-delivery-is-noop` |
| Repository records use immutable external IDs and remain stable across renames | `resource/rename-transfer-keeps-identity` |
| Removing a repository from the selection prevents new provisioning and surfaces existing managed access for reconciliation | `resource/selection-removed-blocks-new-provisioning`; `sellable()` |
| GitHub permissions, invitation limits, personal-repository behaviour and paid-seat implications are documented from live tests and current terms | T6 results file |
| Go/no-go or target-segment decision before Phase 4 | [0008](../decisions/0008-v1-personal-account-repositories.md), confirmed by T6 |

## Risks

- **Administration: write is a frightening permission.** The connect page explains why it's needed and what ShareRepo does with it.
- **No invitation or member webhooks for personal installations** (unverified until T6). The design already relies on polling.
- **GitHub's private keys are PKCS#1.** WebCrypto needs PKCS#8, and the runbook gives the one-line conversion.
- **Queues on local dev and in the Workers test pool** need verifying in T1. The outbox cron path works even without a queue.
