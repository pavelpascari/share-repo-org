# Phase 1 plan — Identity and tenancy

Source: `implementation-plan.md` § Phase 1. Decisions: [0006 authentication](../decisions/0006-authentication-with-better-auth.md), [0007 audit events](../decisions/0007-audit-events.md). Threat model: [purchase claim](../security/purchase-claim-threat-model.md). Spike evidence: branch `spike/better-auth` (reference only, never merged).

## Goal

A person signs in with GitHub, creates a workspace, and comes back to it later. Every workspace read and write is authorized explicitly, and every state change leaves an audit event.

## Out of scope

- GitHub App installations and connections (Phase 2).
- Paddle, subscriber claims and entitlements. Phase 1 only enforces the identity constraints from the threat model.
- Inviting other members to a workspace. The membership model and role checks are built now; the invite flow waits until the private beta needs it.
- UI beyond plain, accessible pages built with React Aria Components.

## Prerequisites (owner: human)

| Item | Notes |
|---|---|
| GitHub OAuth Apps for dev and production | On the personal account. Callback `https://<web host>/api/auth/callback/github`. No scopes. |
| Cloudflare secrets per environment | `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `GITHUB_CLIENT_SECRET`, via `wrangler secret put`. |
| Vars per environment | `GITHUB_CLIENT_ID`, `BETTER_AUTH_URL` in `apps/web/wrangler.jsonc`. |
| Phase 0 deploy setup | D1 databases, API token and `DEPLOY_ENABLED` (see `deployment.md`). It is still pending, and needed before Phase 1 can be checked on dev. |

None of these is needed for local development or any test. Local runs use `.dev.vars` and the fake GitHub server.

## Design summary

- **Identity:** Better Auth owns the `auth_*` tables. ShareRepo owns `users` (minimal) and `external_identities` (unique `(provider, external_user_id)` globally). Both are written from Better Auth hooks through application services, in one `db.batch` with their audit events.
- **Workspace selection is the URL.** Workspace pages live under `/w/:slug`. A `last_workspace` cookie only chooses where `/` redirects after sign-in; it never authorizes anything.
- **Authorization:** `authorizeWorkspace(actor, slug, permission)` returns a `WorkspaceScope` value, and workspace-scoped repository functions take a `WorkspaceScope` rather than a bare ID, so the type system makes scoping visible. A non-member gets **404**, not 403, so workspace slugs cannot be discovered.
- **Roles:** `owner` can manage the workspace; `member` can read it. The policy is a pure function in `@sharerepo/domain`.
- **Audit:** one `audit_events` table, append-only through triggers, with a typed action catalog ([0007](../decisions/0007-audit-events.md)).
- **New package `packages/application`:** services coordinate authorization, domain rules, repositories and audit. Better Auth hooks and React Router loaders and actions call services, never repositories directly.

## Target additions

```text
packages/
  domain/src/      audit.ts (actions, actors, details schemas), authorization.ts (roles → permissions),
                   identity.ts (provider id, GitHub user id and login rules)
  db/src/          schema/auth.ts, schema/identities.ts, schema/audit.ts; migrations/0001_identity_and_audit.sql
                   audit-repository.ts, identity-repository.ts, workspace-repository.ts (+ list, by-slug, scope)
  application/     src/context.ts (RequestContext: actor, correlationId, clock, ids)
                   src/identity.ts (recordSignIn, recordSignOut), src/workspaces.ts (create, listMine, open)
                   src/authorization.ts (authorizeWorkspace → WorkspaceScope)
  testing/src/     audit-completeness.ts (table snapshot diff), fake-github.ts (in-process OAuth client double)
apps/web/
  app/auth/        env.ts, github.ts, auth.ts (Better Auth config + hooks), session.server.ts (requireUser)
  app/routes/      api.auth.ts, home.tsx (signed out: sign in; signed in: redirect), sign-out.ts,
                   workspaces.new.tsx, w.$slug.tsx (workspace home), w.$slug._index.tsx
  app/security/    same-origin.ts (Origin / Sec-Fetch-Site check for actions)
  e2e/support/     fake-github.ts (Node server), serve.ts (+ fake server, CLOUDFLARE_ENV=e2e)
  e2e/             auth.spec.ts, workspaces.spec.ts, isolation.spec.ts
```

## Tasks and parallelisation

Same method as Phase 0. T1 runs first and alone: it installs every dependency, generates the one migration, and adds every config, so the lockfile and the schema don't change while agents run in parallel. Each later task works in its own worktree and touches separate directories. Each is test-first.

```text
T1 deps + schema + migration + config ──┬─ T2 domain: audit catalog, policy, identity ─┐
                                        ├─ T3 db repositories + audit triggers ────────┼─ T5 application services ─┐
                                        └─ T4 GitHub client + auth env (web) ──────────┘                           │
                                                                         T6 Better Auth wiring + routes + UI ─────┤
                                                                         T7 E2E journeys ─────────────────────────┼─ T8 docs + verification
```

T6 needs T4 and T5. T7 needs T6.

### T1 — Dependencies, schema and configuration (serial, lead)

- **Work:**
  - add `better-auth@1.7.10` to `apps/web` (exact version) and create `packages/application` (package.json, tsconfig, vitest project, coverage thresholds entry at the 90% floor);
  - Drizzle schema for `auth_users`, `auth_sessions`, `auth_accounts` (no-token CHECK), `auth_verifications` and `auth_rate_limits`; `external_identities`; `audit_events` with scope CHECKs, the FK to workspaces, and append-only triggers;
  - generate `0001_identity_and_audit.sql`. Triggers are hand-appended to the generated SQL, and `db:check` must still report no drift;
  - wrangler: vars for dev and production, a local-only `e2e` env, and `secrets.required`; regenerate types;
  - `.dev.vars.example`;
  - extend the schema conformance test's exemptions with `audit_events` (with the reason) and the global `auth_*` and `external_identities` tables.
- **Done when:** install, lint, typecheck and test pass, `db:check` is clean, and migrations apply from empty.

### T2 — Domain (parallel)

- **Tests first:**
  - the action catalog: every action has a scope, a target type and a details schema, and the details schemas reject unknown keys, so free-form secrets cannot slip in;
  - the role policy is a total function over roles × permissions, with an explicit table;
  - GitHub user IDs are positive integers, held as strings; logins follow GitHub's rules (1–39 characters, alphanumerics and single hyphens) and are snapshots only;
  - property tests for parsing.
- **Done when:** 100% coverage and 100% mutation score are kept.

### T3 — Database repositories (parallel)

- **Tests first:**
  - `audit_events`: UPDATE and DELETE are rejected; the scope/workspace CHECK and the FK hold;
  - `upsertExternalIdentity` inserts, updates the snapshot on a username change, and **throws** if the GitHub ID belongs to another user;
  - `createWorkspace` writes the workspace, the owner membership and the `workspace.created` and `membership.added` audit rows in one batch, and a duplicate slug raises `ConflictError`;
  - `listWorkspacesForUser` returns only the user's workspaces;
  - `findMembershipBySlug(userId, slug)` returns nothing for non-members;
  - every repository function that writes takes the audit event(s) it must write.
- **Done when:** `packages/db` stays at 100% coverage.

### T4 — GitHub client and auth env (parallel, `apps/web/app/auth`)

- **Tests first:**
  - `parseAuthEnv` rejects the endpoint overrides unless `ENVIRONMENT=e2e`;
  - a test reads both wrangler configs and fails if the dev or production envs set overrides or `ENVIRONMENT=e2e`;
  - `createGitHubClient` exchanges the code with PKCE, Zod-parses `/user`, and classifies errors (bad code, GitHub 5xx, malformed body) without logging tokens.
- **Done when:** canary tests show no secret in logs or errors.

### T5 — Application services (after T2, T3)

- **Tests first** (Workers pool, local D1):
  - `recordSignIn` creates the user and identity on first sign-in and updates the snapshot on a later sign-in with a new login. Scenario `identity/username-change-keeps-identity`;
  - `createWorkspace` validates via domain rules and audits;
  - `listMyWorkspaces`;
  - `authorizeWorkspace`: owner/member/non-member × read/manage;
  - scenario `isolation/cross-workspace-read-denied`: user B gets not-found for workspace A, for every read service;
  - scenario `isolation/cross-workspace-mutation-denied`: user B cannot rename or otherwise mutate A;
  - scenario `audit/every-state-change-has-audit-event`: the completeness helper wraps every service test, and a property test runs random command sequences.
- **Done when:** `packages/application` has at least 90% coverage, ratcheted.

### T6 — Better Auth wiring, routes and UI (after T4, T5)

- **Tests first** (Workers pool, driving the real `/api/auth/sign-in/social` and `/api/auth/callback/github` with the in-process fake GitHub client, as in the spike):
  - first sign-in creates `users`, `auth_*` rows, the identity and audit rows;
  - a forged `state` or a bad code redirects with an error and creates nothing;
  - the half-created-user repair from 0006 works;
  - no OAuth token is stored (canary);
  - sign-out deletes the session and is audited;
  - actions reject cross-origin POSTs;
  - `/w/:slug` returns 404 for a non-member and for a missing slug, with identical bodies;
  - rate limiting is active and uses D1.
- **Work:**
  - Better Auth config per [0006](../decisions/0006-authentication-with-better-auth.md), with hooks that call `recordSignIn` and `recordSignOut`;
  - routes: home, sign-out, new workspace (form with field errors), workspace home, `last_workspace` redirect;
  - React Aria Components for the form controls.
- **Done when:** web coverage stays at 100% for `workers/**` and at least 90% for the new `app/**` code; route modules are covered by E2E where unit tests would be brittle.

### T7 — E2E journeys (after T6)

- **Work:** the fake GitHub server and `serve.ts` changes from the spike, hardened: the fake checks the client secret, `redirect_uri` and PKCE S256, and can serve several users and change a user's login.
- **Specs:**
  - sign in, create a workspace, sign out, sign in again and land in the workspace (acceptance: sign in, create, revisit);
  - the user's login changes at the fake GitHub, they sign in again, and they keep the same account and workspaces;
  - user B opens user A's workspace URL and sees not-found (scenario `isolation/cross-workspace-read-denied`, E2E layer);
  - signing in calls no installation endpoints at the fake (acceptance: no installation connection).
- **Done when:** `pnpm test:e2e` passes from a clean checkout with no network beyond localhost.

### T8 — Docs and verification (lead)

- Update `local-setup.md` (`.dev.vars`, fake GitHub, new commands), `deployment.md` (OAuth Apps, secrets), the `db` README (audit and identity tables), and `domain-model.md` if any field changed.
- Mark decisions 0006 and 0007 accepted. Set `CURRENT_PHASE: 1` in CI.
- Run the full suite from a fresh clone, including mutation and E2E.

## Acceptance criteria (from the implementation plan)

| Criterion | Proven by |
|---|---|
| Sign in, sign out, create a workspace, revisit it | T7 journey spec |
| A GitHub username change does not create a new identity | T5 scenario, T6 callback test, T7 spec |
| Unauthorized users cannot read or mutate another workspace | T5 isolation scenarios, T6 404 test, T7 isolation spec |
| Authorization tests cover horizontal privilege escalation | T5 owner/member/non-member matrix; cross-workspace scenarios |
| Authentication events do not create a GitHub App installation connection | No connection tables exist yet; T7 asserts no installation endpoint is called |

Added by the testing strategy and the decisions:

- scenarios due by phase 1 pass `check:scenarios --phase 1`;
- the audit completeness helper runs for every service test;
- the canary assertion covers audit rows and the no-token CHECK;
- the production config cannot enable the E2E seam.

## Risks and open questions

- **Half-written sign-ins on D1.** Better Auth writes the user and the account separately. 0006 explains why this heals on the next sign-in; the T6 test proves it.
- **Better Auth upgrades** may change hook timing. The callback tests in the Workers pool pin the behaviour.
- **Personal-repo write access** ([research](../research/github-personal-accounts.md)) still needs a product decision before Phase 2.
- **Checkout sign-in requirement** (claim path 1 versus 2) is open in the [threat model](../security/purchase-claim-threat-model.md) and needed before Phase 5.
