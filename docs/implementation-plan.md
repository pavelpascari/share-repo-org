# ShareRepo implementation plan

## Delivery approach

Build in dependency order and make each phase demonstrably usable. Keep provider behavior behind ports, use test doubles before live integrations, and avoid implementing future providers. Each phase ends with migrations, tests, operational notes, and updated documentation.

## Phase 0 — Repository foundation

### Goal

Create a deployable, testable Cloudflare workspace with no provider or provisioning logic.

### Work

- Create a pnpm workspace with `apps/web`, `apps/jobs`, and only the packages justified by immediate code.
- Configure strict TypeScript, React Router, Workers, Vite, Wrangler, Biome, Vitest, and Playwright.
- Provision development and production D1 databases and migration commands.
- Add basic `User`, `Workspace`, and `WorkspaceMembership` schema with constraints.
- Establish environment typing, secrets conventions, structured logging, error handling, and request correlation IDs.
- Add GitHub Actions for lint, typecheck, tests, migration validation, and deployment gates.
- Document local setup and deployment.

### Acceptance criteria

- Web and jobs Workers run locally.
- The web Worker deploys and serves a health/readiness path.
- D1 migrations apply from an empty database and are reproducible in tests.
- A smoke test proves D1 access through the application boundary.
- CI runs lint, typecheck, unit/integration tests, and build.
- No Paddle, GitHub App, queues, workflows, or provisioning behavior exists yet.

## Phase 1 — Identity and tenancy

### Goal

Establish ShareRepo users and explicit workspace authorization.

### Work

- Integrate Better Auth with D1.
- Add GitHub sign-in for user identity.
- Persist ShareRepo `User` and `ExternalIdentity` records using immutable GitHub IDs.
- Implement workspace creation, membership, current-workspace selection, and authorization helpers.
- Add account-linking safeguards and an audit event foundation.
- Define the subscriber purchase-claim threat model before implementing automatic linking.

### Acceptance criteria

- A user can sign in, sign out, create a workspace, and revisit it.
- GitHub username changes do not create a new identity.
- Unauthorized users cannot read or mutate another workspace.
- Authorization tests cover horizontal privilege escalation.
- Authentication events do not create a GitHub App installation connection.

## Phase 2 — GitHub connection and feasibility proof

### Goal

Connect real GitHub installations, discover repositories, and validate the product's largest external constraints before building billing.

### Work

- Register/configure the ShareRepo GitHub App for development.
- Implement installation setup callbacks and signed webhook ingestion.
- Persist `Connection`, `Resource`, and capability snapshots.
- Discover selected repositories and react to selection, suspension, deletion, rename, transfer, and archive changes.
- Implement installation-token handling with least privilege.
- Build a private feasibility spike for read-only access, outside collaborators, invitations, organization policy, and seat cost.
- Record conclusions as an architecture/product decision.

### Acceptance criteria

- An authorized workspace member can install the app and see selected repositories.
- Installation callbacks cannot be attached to the wrong workspace.
- Duplicate installation webhooks are harmless.
- Repository records use immutable external IDs and remain stable across rename.
- Removing repository selection prevents new provisioning and surfaces existing managed access for reconciliation.
- Current GitHub permissions, invitation limits, personal-repository behavior, and paid-seat implications are documented from live tests/current terms.
- There is a clear go/no-go or target-segment decision before Phase 4.

## Phase 3 — Entitlement core and simulated source

### Goal

Prove the subscription–entitlement–grant separation and reconciliation planner without Paddle or live access mutation.

### Work

- Implement `Subject`, `Offer`, commercial item mapping, `Subscription`, `Entitlement`, `Grant`, `ExternalEvent`, and `AuditEvent` schema.
- Create domain policy for active, trialing, past-due/grace, paused, canceled, and expired facts.
- Add a simulated entitlement source/admin fixture path for test workspaces.
- Implement deterministic desired-state calculation and a reconciliation planner.
- Add a transactional outbox if database-to-queue handoff cannot be atomic.
- Build creator views for offer mapping, desired access, observed access, and decision reason.

### Acceptance criteria

- A simulated subscription can create, extend, expire, and remove entitlements.
- Reprocessing the same facts produces the same durable result.
- Out-of-order facts do not regress newer authoritative state.
- Planner tests cover provision, revoke, no-op, pending, error, and unsupported capability cases.
- Every entitlement points to its source and policy version.
- UI language remains repository-centric even though the core uses `Resource`.

## Phase 4 — GitHub provisioning and reconciliation

### Goal

Make GitHub access converge to simulated desired entitlements.

### Work

- Implement subject resolution from linked GitHub identity.
- Inspect direct collaborator and pending invitation state.
- Provision supported read access and revoke ShareRepo-managed direct access.
- Introduce Queues for reconciliation jobs with deterministic deduplication/idempotency keys.
- Re-inspect provider state after mutations and persist grants.
- Model pending invitations and user-action-required failures.
- Add scheduled reconciliation and operator retry/repair controls.
- Ensure pre-existing or indirect GitHub access is not misrepresented or destructively revoked.

### Acceptance criteria

- Active simulated entitlement produces correct GitHub access for a real test repository.
- Expired simulated entitlement removes only access managed by ShareRepo.
- Duplicate jobs and lost responses do not create incorrect results.
- Manual removal is detected and repaired; manual/pre-existing access follows documented ownership policy.
- Rate limits, permission failures, pending invitations, and suspended installations are visible and classified.
- Every attempted and completed mutation has an audit trail.

## Phase 5 — Paddle integration

### Goal

Replace the simulated commercial source with real Paddle facts while retaining the same entitlement engine.

### Work

- Implement Paddle seller connection, preferring supported OAuth; allow a private-launch credential path only if necessary.
- Encrypt dynamic tenant credentials with versioned envelopes.
- Discover products and prices and map them to offers.
- Automate or guide webhook destination registration.
- Verify, deduplicate, and persist signed webhooks.
- Normalize customers, subscriptions, status, billing periods, and effective cancellation.
- Add a secure purchase/subscriber claim and GitHub identity-linking journey.
- Recompute entitlements and enqueue reconciliation from current normalized state.

### Acceptance criteria

- A Paddle sandbox purchase can be claimed by the correct subscriber and grants the mapped repository access.
- Duplicate and out-of-order webhooks converge correctly.
- Failed payment applies grace policy rather than unconditional immediate revocation.
- Effective cancellation revokes at the intended time.
- Renewal/reactivation during a grace or cancellation workflow prevents stale revocation.
- Credential rotation and connection loss are handled without secret leakage.

## Phase 6 — Durable timing and operational hardening

**Status:** delivered. What was built, and where it differs from the work list below, is in the [Phase 6 plan](plans/phase-6.md) and decisions [0013](decisions/0013-database-timers-and-expiry-confirmation.md), [0014](decisions/0014-failure-handling-and-alerting.md) and [0015](decisions/0015-data-lifecycle.md). In short: timers stay in the database and expiry is confirmed before revocation, instead of Workflows; failures are rows with owner and operator pages, a dead-letter queue and email alerts; data is pruned, exported and deleted on a schedule; every secret has a rotation procedure; and the runbooks are under `docs/runbooks/`. Live checks that need a deployed environment are listed in [deployment](deployment.md) § First-deploy checks.

### Goal

Make delayed policy, retries, and recovery safe enough for the founder launch.

### Work

- Add Cloudflare Workflows for grace-period expiry, effective cancellation, and multi-step repairs where they improve durability.
- Reload current state after every durable sleep.
- Partition scheduled reconciliation to respect provider limits.
- Add dead-letter/failure handling, alerting, dashboards, and operator runbooks.
- Add data retention, export, deletion, credential rotation, and incident procedures.
- Run fault-injection tests around crashes, timeouts, duplicated delivery, and provider outages.

### Acceptance criteria

- Workflow replay/retry is idempotent.
- A stale delayed workflow cannot revoke a renewed subscriber.
- Exhausted failures are visible, actionable, and correlated to affected access.
- Scheduled reconciliation repairs missed events and external drift.
- Backup/restore and migration procedures are tested for D1.
- Security review finds no secrets in logs, audit details, or stored raw payloads beyond documented encrypted data.

## Phase 7 — Founder launch and private beta

### Goal

Operate the complete loop for one real creator, then a small invited cohort.

### Work

- Onboard the founder's workspace and a real paid offering.
- Run launch checklists for GitHub permissions, Paddle notifications, alerting, and reconciliation.
- Measure provisioning time, invitation acceptance, drift, support cases, GitHub seat cost, and provider failure rate.
- Add 3–10 invited creators only after founder operation is stable.
- Improve onboarding and failure UX from observed friction.
- Decide whether the repo-only positioning and economics support a public SaaS.

### Acceptance criteria

- At least one real subscription lifecycle completes from purchase through eventual revocation without database intervention.
- Operator can explain every access state from product-visible history.
- No unresolved critical cross-tenant, access-control, or secret-handling issue remains.
- GitHub collaborator economics and invitation behavior are viable for the chosen initial customer segment.
- A written decision defines the next step: continue private beta, change target segment/access mechanism, or stop.

## Phase 8 — Public SaaS readiness, only after validation

Potential work includes public GitHub App distribution, self-service Paddle connection, ShareRepo's own billing, quotas, abuse controls, support tooling, legal/privacy material, service objectives, and public onboarding. This phase is intentionally not designed in detail before private validation.

## Cross-phase test matrix

Every production mechanism should accumulate adversarial coverage for:

- workspace isolation;
- duplicate and out-of-order external events;
- repeated queue delivery and workflow replay;
- provider success with lost response;
- partial transaction and crash recovery;
- identity unlink/relink and username change;
- subscription renewal during scheduled revocation;
- resource removal or connection suspension;
- pending invitation expiration;
- rate limit and provider outage;
- manual access drift;
- audit completeness and secret redaction.

## Deferred decisions

Resolve these with evidence at the named phase rather than guessing now:

- exact React Router and Cloudflare package versions — Phase 0;
- Better Auth schema ownership and mapping to domain users — Phase 1;
- exact GitHub App permissions and viable repository ownership models — Phase 2;
- access ownership policy for pre-existing or indirect grants — Phase 2–4 (resolved: ShareRepo manages only access it created, decision 0010);
- fixed versus creator-configurable grace period — Phase 3 or private beta (resolved: per offer, decision 0009);
- Paddle OAuth availability and approval path versus temporary credentials — Phase 5 (resolved: seller API keys now, OAuth after publisher-program approval, decision 0011);
- Workflows versus database-scheduled jobs for each timer — Phase 6 (resolved: database timers swept every minute, no Workflows, and expiry confirmed before revocation, decision 0013);
- public pricing, quotas, and self-hosting — after private beta.

## First Codex task after adding this pack

> Read `AGENTS.md` and all files under `docs/`. Do not implement the application yet. Inspect the architecture and propose a concrete Phase 0 repository structure, dependency set, commands, Cloudflare bindings, and CI plan. Identify inconsistencies or decisions that must be made before scaffolding, especially current package compatibility. Keep the proposal limited to Phase 0.

