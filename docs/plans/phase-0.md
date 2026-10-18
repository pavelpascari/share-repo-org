# Phase 0 plan — Repository foundation

Source: `implementation-plan.md` § Phase 0. Testing rules: `testing-strategy.md`. Versions: `decisions/0001-stack-versions.md`.

## Goal

A deployable, testable Cloudflare workspace with no provider or provisioning logic, and with the full test harness, coverage ratchet, and CI in place so every later phase starts green.

## Out of scope

Paddle, GitHub App, Better Auth, Queues, Workflows, provisioning, and UI beyond a placeholder page. (`apps/jobs` has only a scheduled handler stub.)

## Prerequisites (owner: human)

| Item | Notes |
|---|---|
| Node ≥ 22.22 (24 LTS recommended) | The current local machine runs 22.17 and must upgrade. |
| pnpm 10 | Already installed (10.11). Pinned through `packageManager`. |
| Cloudflare account access | Needed to create D1 databases and an API token for CI. Local development and all tests do not need it. |
| D1 databases `sharerepo-dev` and `sharerepo-prod` | `wrangler d1 create …`; IDs go into the Wrangler configs. |
| GitHub repository secrets | `CLOUDFLARE_API_TOKEN` (Workers + D1 edit), `CLOUDFLARE_ACCOUNT_ID`. |
| Deployment target | Phase 0 deploys to `*.workers.dev`. Attaching `sharerepo.org` is a separate, explicit step. |

## Target layout after Phase 0

```text
.
├── apps/
│   ├── web/                     # React Router on Workers
│   │   ├── app/
│   │   │   ├── routes/          # home placeholder, /healthz, /readyz
│   │   │   └── root.tsx
│   │   ├── workers/app.ts       # Worker entry: correlation ID, logging, error boundary
│   │   ├── test/                # Workers-project tests
│   │   ├── e2e/                 # Playwright specs
│   │   └── wrangler.jsonc
│   └── jobs/
│       ├── src/index.ts         # scheduled handler stub (+ fetch /healthz for local runs)
│       ├── test/
│       └── wrangler.jsonc
├── packages/
│   ├── domain/                  # pure TS: ids, Clock port, workspace slug/role rules
│   ├── db/                      # Drizzle schema, migrations, workspace-scoped repositories
│   ├── platform/                # env parsing (Zod), logger with redaction, correlation IDs, error types
│   └── testing/                 # D1 helpers, fake clock, deterministic IDs, log capture, secret canaries
├── scripts/
│   ├── coverage-ratchet.ts      # CI checks 2 and 3 from decision 0005
│   └── scenario-catalog.ts      # checks scenario names in testing-strategy.md exist as tests
├── .github/workflows/ci.yml, deploy.yml
├── biome.json, tsconfig.base.json, vitest.config.ts, playwright.config.ts
├── pnpm-workspace.yaml, package.json, .nvmrc
└── docs/
```

Why each package exists now:

- `domain` holds rules the schema enforces (slug format, roles) and the `Clock` and ID ports that every later phase needs. It is the mutation-tested package.
- `db` holds the schema and migrations shared by both Workers.
- `platform` holds logging, correlation, and env parsing that both Workers need.
- `testing` is shared test infrastructure.

`packages/application` (application services) and `packages/integrations` are created in Phases 1 and 2, when the first code needs them.

## Configuration decisions

- **Wrangler:** one config per app, both binding D1 as `DB` and setting `migrations_dir: ../../packages/db/migrations` ([0002](../decisions/0002-one-wrangler-config-per-worker.md)). Environments are the top level (local/dev) and `env.production`. Binding types are generated with `wrangler types` and checked for drift in CI.
- **Web bindings:** `DB`, var `ENVIRONMENT`. **Jobs bindings:** `DB`, var `ENVIRONMENT`, a cron trigger (for example hourly) running a no-op that logs a heartbeat.
- **Schema conventions** (recorded in `packages/db/README.md`):
  - IDs are `TEXT` (UUIDv7 or ULID from the ID port).
  - Timestamps are `INTEGER` UTC milliseconds.
  - Enumerations use `CHECK` constraints.
  - Tenant tables carry `workspace_id` with `UNIQUE(workspace_id, id)` and composite foreign keys ([0004](../decisions/0004-workspace-scoped-composite-foreign-keys.md)).
  - Atomic writes use `db.batch()` ([0003](../decisions/0003-d1-batches-and-transactional-outbox.md)).
- **Schema v0:**
  - `users(id, created_at, updated_at)`. This table is deliberately minimal; Better Auth table ownership is decided in Phase 1.
  - `workspaces(id, slug UNIQUE CHECK(format), name CHECK(length), status CHECK IN ('active','suspended'), created_at, updated_at)`.
  - `workspace_memberships(workspace_id FK, user_id FK, role CHECK IN ('owner','member'), created_at, PRIMARY KEY(workspace_id, user_id))`.
- **Vitest:** a root `vitest.config.ts` with `test.projects` covering `domain` and `platform` (Node), `db`, `testing`, `web` and `jobs` (Workers, through `cloudflareTest()`). Coverage uses Istanbul, merged at the root, with per-package `thresholds` that `autoUpdate` rounds down to one decimal.
- **Logging:** JSON lines through `console`, with key-based redaction from a denylist. Fields are `ts, level, msg, correlationId, workspaceId?, …`. The correlation ID comes from an `x-request-id` header when present and valid, otherwise it is generated. It is echoed in the response header.

## Tasks and parallelisation

Task 1 runs first and alone: it creates every config file and installs **all** Phase 0 dependencies, so the lockfile and root config don't change again. Tasks 2–5 then run in parallel (sub-agents, one git worktree each), touching disjoint directories. Tasks 6–8 follow.

```text
T1 skeleton ──┬─ T2 test harness + ratchet ─┐
              ├─ T3 db schema + migrations ─┼─┬─ T5 jobs worker ─────────────────┐
              └─ T4 platform ───────────────┘ └─ T6 web worker ── T7 E2E harness ─┼─ T9 docs + final verification
                                                T8 CI (after T2) ─────────────────┘
```

T5 depends on T4 because the scheduled heartbeat uses the platform logger, so it runs in the second wave alongside T6. Only the lead edits the root `package.json`; parallel tasks report the scripts they need.

Each task is test-first: write the failing tests listed, then implement.

### T1 — Workspace skeleton (serial)

- **Work:**
  - root `package.json` with `packageManager`, `engines`, and the scripts below;
  - `pnpm-workspace.yaml` with `onlyBuiltDependencies: [workerd, esbuild]`;
  - `.nvmrc`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `biome.json`;
  - package stubs with `package.json` and `tsconfig.json`;
  - every dependency from 0001 at its exact pinned version;
  - root `vitest.config.ts` listing every project, plus one trivial passing test per project.
- **Done when:** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` pass on a clean clone.

### T2 — Test harness and coverage ratchet (parallel)

- **Tests first:**
  - `scripts/coverage-ratchet` unit tests: fails when a threshold is lowered against a base file; fails when measured coverage exceeds the committed threshold by more than the margin; passes with a `coverage-decrease` override.
  - `scripts/scenario-catalog` tests: parses the table in `testing-strategy.md` and reports scenarios that are due but missing.
- **Work:**
  - `packages/testing`: `FakeClock`, `SequentialIds`, `captureLogs()`, `withSecretCanaries()` with an `expectNoCanaryLeak()` assertion, and `freshWorkspaceIds()` to cope with per-file D1 isolation;
  - Istanbul coverage configuration with per-package floors from [0005](../decisions/0005-coverage-ratchet.md);
  - Stryker config for `packages/domain` with `thresholds.break` ratcheted the same way.
- **Done when:** `pnpm test:coverage` and `pnpm test:mutation` run locally, and the ratchet scripts are covered at ≥ 90%.

### T3 — Database schema and migrations (parallel)

- **Tests first** (Workers project with local D1):
  - migrations apply from empty;
  - every `CHECK`, `UNIQUE`, and foreign key rejects invalid rows (one test each);
  - a membership row cannot reference a missing workspace or user;
  - repositories always require a `workspaceId` and never return another workspace's rows;
  - a **schema conformance test** reads `sqlite_master` and `PRAGMA foreign_key_list` and fails if any table with `workspace_id` lacks `UNIQUE(workspace_id, id)` or references a tenant table without a composite key. Tables can be explicitly exempt; `workspace_memberships` is exempt because its primary key is composite.
- **Work:**
  - Drizzle schema and generated SQL migrations;
  - confirm the drizzle-kit 0.31 output layout works with `wrangler d1 migrations apply` and `readD1Migrations` (open item in 0001);
  - `createWorkspace(ownerUserId, …)`, which uses one `batch()` to insert the workspace and its owner membership; `getWorkspaceForMember(workspaceId, userId)`;
  - `pnpm db:generate`, `db:migrate:local`, `db:migrate:dev`, `db:migrate:prod`.
- **Done when:** coverage of `packages/db` is ≥ 90% and migration validation from empty passes.

### T4 — Platform utilities (parallel)

- **Tests first:**
  - env parsing rejects missing or invalid bindings with a clear error and never echoes secret values;
  - the logger redacts keys matching the denylist (`token`, `secret`, `authorization`, `cookie`, `password`, `private_key`, …) at any depth;
  - secret canaries never appear in logs or errors;
  - correlation IDs accept valid incoming headers, reject oversized or invalid ones, and generate a new one otherwise;
  - the error hierarchy maps to HTTP status without leaking internals.
- **Work:** `parseEnv(schema, env)`, `createLogger(context)`, `correlationIdFrom(request, ids)`, `AppError` subclasses (`NotFound`, `Forbidden`, `Validation`, `Conflict`).
- **Done when:** `platform` coverage is ≥ 90%.

### T5 — Jobs Worker (parallel)

- **Tests first:** `createScheduledController` invokes `scheduled()`, which writes a heartbeat log with a correlation ID; `GET /healthz` answers locally.
- **Work:** `apps/jobs/src/index.ts`, `wrangler.jsonc` with the cron trigger and `DB` binding.
- **Done when:** `pnpm --filter jobs dev` runs locally and its tests pass.

### T6 — Web Worker (after T3, T4)

- **Tests first** (Workers project, through `exports.default.fetch`):
  - `/healthz` returns 200 without touching D1;
  - `/readyz` runs `SELECT 1` through the `db` package. This is the D1 smoke test through the application boundary. It returns 503 with a classified error when D1 is unavailable;
  - every response carries `x-request-id`;
  - unhandled errors produce a generic 500 and a structured log with no stack trace or secret in the body.
- **Work:** React Router app with a placeholder home route, the two resource routes, and a Worker entry wrapping the request handler with correlation and error handling. Tailwind is wired in, but there are no UI components yet.
- **Done when:** `pnpm --filter web dev` serves locally against local D1, and `pnpm --filter web build` succeeds.

### T7 — E2E harness (after T6)

- **Work:** `playwright.config.ts` with `webServer` starting both Workers against a fresh local D1 state directory per run (deleted and migrated in `globalSetup`). Specs: home page loads; `/readyz` reports D1 ready; responses carry `x-request-id`.
- **Done when:** `pnpm test:e2e` passes from a clean checkout with no network access beyond `localhost`.

### T8 — CI and deploy (after T2; finalised after T7)

- **`ci.yml` on PRs:**
  - `pnpm install --frozen-lockfile`;
  - `pnpm lint`, `pnpm typecheck`;
  - check `wrangler types` for drift;
  - `pnpm test:coverage` plus `scripts/coverage-ratchet` against the base branch;
  - `scripts/scenario-catalog`;
  - migration validation (apply all migrations to an empty local D1, then check that `drizzle-kit generate` produces no diff);
  - `pnpm build`, `pnpm test:e2e`;
  - `pnpm test:mutation` when `packages/domain` changed.
- **`deploy.yml` on `main`:**
  - repeat the CI gates;
  - apply migrations to dev, then deploy jobs and web to dev, then smoke `/readyz`;
  - production is a manual approval through a GitHub environment, running the same steps.
- **Done when:** a PR shows every check, and a merge to `main` deploys dev and serves `/readyz`.

### T9 — Documentation and final verification

- `docs/local-setup.md`: prerequisites, install, local dev for both Workers, migrations, every test command, and troubleshooting (Node version, workerd build scripts, per-file D1 isolation).
- `docs/deployment.md`: environments, secrets, migration-then-deploy order, rollback notes.
- Update `AGENTS.md` verification commands if any changed, and add the coverage rule.
- Final run from a fresh clone: `pnpm install && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:mutation && pnpm test:e2e && pnpm build`.

## Root scripts

| Script | Purpose |
|---|---|
| `dev` | Run web and jobs locally |
| `build` | Build both Workers |
| `lint` / `format` | Biome check / write |
| `typecheck` | `tsc -b` across the workspace plus React Router typegen |
| `test` | All Vitest projects |
| `test:coverage` | Merged Istanbul coverage with thresholds and auto-update |
| `test:mutation` | Stryker on `packages/domain` |
| `test:e2e` | Playwright against local Workers |
| `test:sandbox` | Placeholder that exits cleanly until Phase 2 |
| `db:generate`, `db:migrate:{local,dev,prod}` | Drizzle generate and Wrangler apply |

## Acceptance criteria (from the implementation plan)

| Criterion | Proven by |
|---|---|
| Web and jobs Workers run locally | T5, T6 dev commands; T7 `webServer` |
| Web Worker deploys and serves health/readiness | T8 deploy smoke on dev |
| D1 migrations apply from empty and are reproducible in tests | T3 tests; T8 migration validation |
| Smoke test proves D1 access through the application boundary | T6 `/readyz` test |
| CI runs lint, typecheck, unit/integration tests, and build | T8 |
| No Paddle, GitHub App, queues, workflows, or provisioning exists | Review checklist; no such dependencies or bindings in the configs |

Added by `testing-strategy.md`: coverage ratchet and mutation gate active; scenario `audit/no-secrets-in-logs-or-audit` (logging part) and `isolation/composite-fk-rejects-cross-tenant-link` (convention test) present.

## Risks and open questions

- **Node upgrade** is required locally before T1.
- **Drizzle-kit migration layout** versus Wrangler is unverified; T3 resolves it first.
- **Workers plugin and pinned Wrangler/Miniflare versions** are recent (Miniflare 5 is still a beta). If T1 hits instability, fall back to the last plugin version known to work and record it in 0001.
- **GitHub personal repositories grant write access to every collaborator** ([research](../research/github-personal-accounts.md)). This does not block Phase 0, but it is a product decision needed before Phase 2: see the summary in that document.
