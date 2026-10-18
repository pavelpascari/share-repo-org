# Local setup

Everything in ShareRepo builds, runs, and tests on a laptop without Cloudflare credentials or provider accounts. Versions are pinned in [decision 0001](decisions/0001-stack-versions.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | 24 LTS (`.nvmrc`), at least 22.22.0 | React Router 8 refuses older Node. With mise: `mise install node@24` and `mise use node@24`. With nvm: `nvm install && nvm use`. |
| pnpm | pinned by `packageManager` | `corepack enable` installs the exact version. |
| Playwright browsers | matching `@playwright/test` | `pnpm exec playwright install chromium`, once, for `pnpm test:e2e`. |

## First run

```sh
corepack enable
pnpm install
pnpm db:migrate:local      # apply migrations to the local D1 used by `pnpm dev`
pnpm dev                   # web on http://localhost:5173, jobs on http://localhost:8788
```

pnpm blocks dependency build scripts by default; `pnpm-workspace.yaml` allows only `workerd` and `esbuild`, which the Workers runtime needs.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | React Router app and HTTP entry Worker (`workers/app.ts`) |
| `apps/jobs` | Background Worker: cron now; queues and workflows later |
| `packages/domain` | Pure domain rules and ports (`Clock`, `IdGenerator`); mutation-tested |
| `packages/db` | Drizzle schema, SQL migrations, workspace-scoped repositories |
| `packages/platform` | Env parsing, structured logging with redaction, correlation IDs, error types |
| `packages/testing` | Test helpers: fake clock, deterministic IDs, log capture, secret canaries |
| `scripts` | Coverage ratchet and scenario-catalog checks |

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run both Workers locally against local D1 |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | Wrangler type drift check, React Router typegen, `tsc` for every package |
| `pnpm test` | Every Vitest project (Node and Workers runtimes) |
| `pnpm test:coverage` | Tests with merged coverage, then raises committed thresholds in `coverage-thresholds.json` |
| `pnpm test:mutation` | Stryker on `packages/domain` (slow; run when domain changes) |
| `pnpm test:e2e` | Playwright against both Workers with a fresh local D1 |
| `pnpm check:scenarios --phase <n>` | Fails if a scenario due by phase `n` in `docs/testing-strategy.md` has no test |
| `pnpm db:generate` | Generate a SQL migration from schema changes in `packages/db/src/schema` |
| `pnpm db:check` | Fails if the schema and committed migrations disagree |
| `pnpm build` | Build both Workers |

Run a single project or file with Vitest directly, for example `pnpm exec vitest run --project db` or `pnpm exec vitest run packages/platform/test/redact.test.ts`.

## Coverage never decreases

`coverage-thresholds.json` holds the committed thresholds per package. They can only go up ([decision 0005](decisions/0005-coverage-ratchet.md)). After adding tests, run `pnpm test:coverage` and commit the updated file; CI fails if measured coverage is higher than what is committed, lower than it, or if a threshold went down without an approved `coverage-decrease` label.

## Changing the database schema

1. Edit `packages/db/src/schema`.
2. `pnpm db:generate` and review the SQL in `packages/db/migrations`. Migrations must be safe for a running service: add before you remove, and backfill in a separate step.
3. Add a test per new constraint, and keep the schema conformance test passing (tenant tables need `workspace_id`, `UNIQUE(workspace_id, id)`, and composite foreign keys; see [decision 0004](decisions/0004-workspace-scoped-composite-foreign-keys.md)).
4. `pnpm db:migrate:local` to update your dev database.

## Troubleshooting

- **`Unsupported engine` or React Router refuses to start:** Node is older than 22.22. Switch with your version manager.
- **`workerd` fails to start after install:** build scripts were blocked; check `onlyBuiltDependencies` in `pnpm-workspace.yaml` and rerun `pnpm install`.
- **A test sees data from another test:** D1 storage is isolated per test *file*, not per test. Give each test its own IDs (`freshWorkspaceIds()` from `@sharerepo/testing`).
- **`wrangler types --check` fails in `pnpm typecheck`:** a `wrangler.jsonc` changed; run `pnpm --filter @sharerepo/web typegen` (or `jobs`) and commit the regenerated `worker-configuration.d.ts`.
- **Local D1 state looks wrong:** delete `apps/web/.wrangler` and run `pnpm db:migrate:local` again.
