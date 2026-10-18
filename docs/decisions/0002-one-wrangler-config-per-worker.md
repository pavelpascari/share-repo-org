# 0002 — One Wrangler config per Worker, shared D1 and migrations

**Status:** Proposed

## Context

`architecture.md` shows a single root `wrangler.jsonc`, but the system has two deployables: `apps/web` and `apps/jobs`. A Wrangler configuration describes one Worker, its entry point, and its bindings. Both Workers read and write the same D1 database, and migrations live in `packages/db/migrations`.

## Decision

- Each app owns its own `wrangler.jsonc` (`apps/web/wrangler.jsonc`, `apps/jobs/wrangler.jsonc`).
- Both bind the same D1 database under the same binding name (`DB`) and set `migrations_dir` to `../../packages/db/migrations`.
- Only one place applies migrations: the root `pnpm db:migrate:*` scripts, which run through the `web` config. The `jobs` deployment never applies migrations.
- Shared binding types are generated per app and checked in CI.

## Consequences

- There is no root `wrangler.jsonc`. `architecture.md` should be read as "Wrangler configuration" rather than as a single file.
- Deployment order matters when a migration and code change ship together: apply migrations first, then deploy `jobs` and `web`. Migrations must stay backwards compatible with the currently deployed code (see `AGENTS.md`).
