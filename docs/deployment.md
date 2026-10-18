# Deployment

ShareRepo deploys two Workers, `sharerepo-web` and `sharerepo-jobs`, that share one D1 database per environment ([decision 0002](decisions/0002-one-wrangler-config-per-worker.md)). Deployment runs from GitHub Actions (`.github/workflows/ci.yml`) after every check passes on `main`.

## Environments

| Environment | Wrangler env | Workers | D1 database | Trigger |
|---|---|---|---|---|
| dev | top level | `sharerepo-web`, `sharerepo-jobs` | `sharerepo-dev` | every push to `main` |
| production | `production` | `sharerepo-web-production`, `sharerepo-jobs-production` | `sharerepo-prod` | after dev, with manual approval |

Phase 0 serves from `*.workers.dev`. Attaching `sharerepo.org` is a separate, explicit change.

## One-time setup

1. Create the databases and copy their IDs into both `apps/web/wrangler.jsonc` and `apps/jobs/wrangler.jsonc` (top level for dev, `env.production` for production):

   ```sh
   pnpm --filter @sharerepo/web exec wrangler d1 create sharerepo-dev
   pnpm --filter @sharerepo/web exec wrangler d1 create sharerepo-prod
   ```

2. Create a Cloudflare API token with **Workers Scripts: Edit** and **D1: Edit** for the account.
3. In the GitHub repository, create environments `dev` and `production`. Add a required reviewer to `production`.
4. Add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (repository or per environment), and a `WEB_URL` variable on each environment (for example `https://sharerepo-web.<subdomain>.workers.dev`).
5. Create a **GitHub OAuth App** per environment (on the personal account is fine) for sign-in ([decision 0006](decisions/0006-authentication-with-better-auth.md)). Callback URL: `<WEB_URL>/api/auth/callback/github`. It needs no scopes. This is separate from the GitHub App added in Phase 2.
6. In `apps/web/wrangler.jsonc`, set `BETTER_AUTH_URL` (the web Worker's public URL) and `GITHUB_CLIENT_ID` for the top level (dev) and `env.production`. The production URL must be https.
7. Set the web Worker's secrets for each environment. The web Worker fails closed without them, so the `/readyz` smoke test fails until they are set:

   ```sh
   cd apps/web
   openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
   # and again with --env production
   ```

8. Set the repository variable `DEPLOY_ENABLED` to `true`. Until then, CI runs every check but skips deployment.

ShareRepo-owned secrets are added with `wrangler secret put <NAME> [--env production]`, never committed; `secrets.required` in `wrangler.jsonc` lists them. Local values go in `apps/*/.dev.vars`, which is gitignored. The wrangler `e2e` environment is for local Playwright runs only and is never deployed; a test fails if CI ever selects it.

## Order of operations

Each deployment job runs, in order:

1. `pnpm db:migrate:dev` / `pnpm db:migrate:prod` — apply pending migrations.
2. Deploy `jobs`.
3. Build and deploy `web`.
4. Smoke test `GET $WEB_URL/readyz`, which checks D1 through the application.

Because migrations run before the new code, **every migration must be compatible with the code currently deployed**. Expand first (add tables, nullable columns, new constraints that existing rows satisfy), deploy code that uses them, and contract (drop or tighten) in a later release.

## Rollback

- **Code:** `wrangler rollback` for the affected Worker (from `apps/web` or `apps/jobs`, with `--env production` for production), or revert the commit on `main` and let CI redeploy.
- **Schema:** D1 migrations are forward-only. Write a new migration that reverses the change. Because migrations are backwards compatible, rolling back code does not require rolling back schema.
- **Data:** D1 Time Travel can restore a database to a point in time (`wrangler d1 time-travel restore`). Treat this as an incident procedure; it discards later writes.

## Manual deploy (emergency only)

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
pnpm db:migrate:dev
pnpm --filter @sharerepo/jobs run deploy
pnpm --filter @sharerepo/web build && pnpm --filter @sharerepo/web run deploy
```

For production, add `--env production` to the jobs deploy, build web with `CLOUDFLARE_ENV=production`, and use `pnpm db:migrate:prod`.
