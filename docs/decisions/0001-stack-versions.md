# 0001 — Stack versions and tool compatibility

**Status:** Proposed (verified 2026-10-18; evidence in [`docs/research/stack-versions.md`](../research/stack-versions.md))

## Context

`AGENTS.md` requires confirming compatible versions before scaffolding. Several tools changed recently: the Workers Vitest integration was renamed, React Router 8 raised the Node floor, TypeScript 7 replaced the classic compiler API, and Stryker does not yet work correctly with Vitest 5.

## Decision

Pin exact versions in `package.json` (no `^`) and upgrade deliberately through Renovate/Dependabot PRs that must pass the full suite.

| Concern | Package | Version | Why this one |
|---|---|---|---|
| Runtime | Node | **24 LTS** (floor 22.22.0) | React Router 8 requires ≥ 22.22.0; Vitest, Wrangler, Stryker require ≥ 22. Pinned in `.nvmrc` and `engines`. |
| Package manager | pnpm | 10.x (pinned via `packageManager`) | Must explicitly allow `workerd` and `esbuild` build scripts (`onlyBuiltDependencies`). |
| Language | typescript | **6.0.3** | TS 7.0 is the native compiler and drops the classic API that several tools import. Revisit once Stryker, drizzle-kit, and Vite plugins are confirmed on 7. |
| Web framework | react-router, @react-router/dev | 8.4.0 | Works with the Cloudflare Vite plugin; `@react-router/cloudflare` is not needed. |
| UI | react, react-dom | 19.3.1 | React Router 8 requires ≥ 19.2.7. |
| Build | vite | 8.3.4 | |
| Workers dev/build | @cloudflare/vite-plugin | 1.64.0 | |
| Workers CLI | wrangler | **4.151.1** | Exact match with the version the test plugin pins, to avoid duplicate Miniflare/workerd copies. |
| Types | @cloudflare/workers-types | 5.x (generated `wrangler types` preferred) | Wrangler peers on v5. |
| Test runner | vitest, @vitest/coverage-istanbul | **4.1.12** | Stryker reports every covered mutant as survived on Vitest 5 (stryker-js #6210). One Vitest version across all packages. Move to 5 when fixed. |
| Workers tests | **@cloudflare/vitest-plugin** | 1.4.4 | Replaces the deprecated `@cloudflare/vitest-pool-workers`. Configured with `cloudflareTest()` in plain `defineProject`. |
| Coverage provider | Istanbul | — | Works in both Node and Workers projects with merged reports. V8 support in the Workers plugin arrived on 2026-10-08 (1.4.0); revisit after it has matured. |
| Mutation testing | @stryker-mutator/core, vitest-runner | 10.0.0 | Used only on `packages/domain` (Node project). |
| Property testing | fast-check | 4.10.2 | |
| ORM | drizzle-orm / drizzle-kit | **0.45.4 / 0.31.11** (stable) | Drizzle's D1 page recommends the 1.0 RC; prefer stable `latest` for a production schema. Better Auth peers on both. Revisit at 1.0 GA. |
| Auth (Phase 1) | better-auth | 1.7.10 via Drizzle adapter | One schema and migration source; avoids the Kysely D1 schema-validation issue fixed in 1.7.10. |
| Validation | zod | 4.6.7 | Same major as Better Auth's dependency. |
| Styling | tailwindcss, @tailwindcss/vite | 4.3.3 | |
| Components | react-aria-components | 1.22.1 | |
| Lint/format | @biomejs/biome | 2.5.15 | |
| E2E | @playwright/test | 1.64.1 | |
| HTTP mocking (optional) | msw, @msw/cloudflare | 3.0.3, 0.2.0 | Only if injected `fetch` is insufficient; `fetchMock` was removed from `cloudflare:test`. |

## Testing API facts relied on

- `readD1Migrations` is imported from `@cloudflare/vitest-plugin` (package root, not `/config` as some docs show); `applyD1Migrations`, `createMessageBatch`, `getQueueResult`, `createScheduledController`, `introspectWorkflow(Instance)` come from `cloudflare:test`.
- `env` and `exports` come from `cloudflare:workers`; `env`/`SELF` from `cloudflare:test` are deprecated.
- **Storage is isolated per test file, not per test.** Tests in one file share D1 state: use unique IDs per test or `reset()` in `afterEach`.
- Workflow introspectors must be disposed (`await using`) or state leaks across tests.
- A root Vitest `projects` config can mix a Node project and a Workers project in one run with merged coverage (verified locally on 4.1.12).
- `coverage.thresholds.autoUpdate` accepts a function (Vitest ≥ 4.0) — used for rounding down in the coverage ratchet ([0005](0005-coverage-ratchet.md)).
- Drizzle's D1 driver supports `db.batch()` (atomic); `db.transaction()` is not usable on D1 ([0003](0003-d1-batches-and-transactional-outbox.md)).

## Open items

- **E2E sign-in (Phase 1).** Better Auth's GitHub provider hardcodes GitHub URLs. Options: (a) `genericOAuth` against a local fake in the E2E build only, which exercises a different callback path; (b) keep the real GitHub social provider and redirect its outbound token/user calls to a fake server through an E2E-only `fetch` seam, plus Playwright routing of the browser authorize redirect. Decide in Phase 1 with a spike; prefer (b) if it stays small, because it tests the production path.
- Drizzle-kit 0.31 migration folder layout with `wrangler d1 migrations apply` — confirm in Phase 0 task 3.

## Consequences

- Contributors need Node ≥ 22.22 (24 LTS recommended) locally.
- Upgrades to Vitest 5, TypeScript 7, Drizzle 1.0, and V8 coverage are explicit follow-ups, each gated by the full suite.
