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
6. In `apps/web/wrangler.jsonc`, set `BETTER_AUTH_URL` (the web Worker's public URL) and `GITHUB_CLIENT_ID` for the top level (dev) and `env.production`. Set the same URL as `PUBLIC_BASE_URL` in `apps/jobs/wrangler.jsonc`: the jobs Worker puts it in claim links. The production URL must be https; both Workers fail closed otherwise.
7. Set the web Worker's secrets for each environment. The web Worker fails closed without them, so the `/readyz` smoke test fails until they are set:

   ```sh
   cd apps/web
   openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
   # and again with --env production
   ```

8. Create the **GitHub App** per environment ([runbook](runbooks/github-app-setup.md)), with the setup URL `<WEB_URL>/github/setup` and the webhook URL `<WEB_URL>/webhooks/github`. Set `GITHUB_APP_ID` and `GITHUB_APP_SLUG` in `apps/web/wrangler.jsonc` and `GITHUB_APP_ID` in `apps/jobs/wrangler.jsonc` (top level and `env.production`). Then set the secrets:

   ```sh
   cd apps/web
   pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY   # PKCS#8, see the runbook
   pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
   cd ../jobs
   pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY
   # and again with --env production
   ```

9. Set the Paddle and claim secrets ([decision 0011](decisions/0011-paddle-connection-and-tenant-credentials.md), [decision 0012](decisions/0012-purchase-claims.md)) on **both** Workers, with the **same values** in each, because both read the same database. Use different values per environment. Both Workers fail closed outside local development without them.

   - `CREDENTIAL_KEYS`: the keyring that wraps every stored Paddle API key and webhook secret, `{"current":"k1","keys":{"k1":"<base64 of 32 random bytes>"}}`.
   - `CLAIM_SIGNING_KEY`: signs checkout claim references and hashes claim emails; at least 32 bytes.

   ```sh
   node -e 'console.log(JSON.stringify({current: "k1", keys: {k1: require("node:crypto").randomBytes(32).toString("base64")}}))' > keyring.json
   openssl rand -hex 32 > claim-key.txt
   for app in web jobs; do
     (cd apps/$app && pnpm exec wrangler secret put CREDENTIAL_KEYS < ../../keyring.json \
       && pnpm exec wrangler secret put CLAIM_SIGNING_KEY < ../../claim-key.txt)
   done
   # and again with --env production, with new values
   ```

   Store both in the password manager, then delete the files. Treat `CREDENTIAL_KEYS` like the GitHub App private key: losing it makes every stored Paddle credential unreadable, and every creator must reconnect. To rotate it, add a key to `keys`, make it `current`, and keep the old one: envelopes under the old key are re-wrapped as they are used. Remove the old key only once no envelope references it. Changing `CLAIM_SIGNING_KEY` invalidates open checkout claims and makes rate-limit buckets start over; claim links already sent keep working.

10. Create the queues that carry webhook work from web to jobs:

   ```sh
   pnpm --filter @sharerepo/web exec wrangler queues create sharerepo-events-dev
   pnpm --filter @sharerepo/web exec wrangler queues create sharerepo-events-prod
   ```

11. Set the repository variable `DEPLOY_ENABLED` to `true`. Until then, CI runs every check but skips deployment.

ShareRepo-owned secrets are added with `wrangler secret put <NAME> [--env production]`, never committed; `secrets.required` in `wrangler.jsonc` lists them. Local values go in `apps/*/.dev.vars`, which is gitignored. The wrangler `e2e` environment is for local Playwright runs only and is never deployed; a test fails if CI ever selects it.

## Claim emails

The jobs Worker sends purchase claim links ([decision 0012](decisions/0012-purchase-claims.md), path 2) through Cloudflare Email Service's `send_email` binding, named `EMAIL`. It is not declared yet: until a sending domain is onboarded the binding cannot deliver, and declaring it would make local development and tests report mail as configured. Without it, the claim page reports that claiming by email is unavailable; the other claim paths still work.

Once `sharerepo.org` (or the sending subdomain) is onboarded to Email Sending in the Cloudflare dashboard:

1. Set `MAIL_FROM` in `apps/jobs/wrangler.jsonc` (top level and `env.production`) to an address on that domain, for example `ShareRepo <claims@sharerepo.org>`.
2. Add the binding to the top level and to `env.production` of `apps/jobs/wrangler.jsonc` (named environments do not inherit it), next to `queues`:

   ```jsonc
   "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["claims@sharerepo.org"] }],
   ```

3. Run `pnpm --filter @sharerepo/jobs typegen`, and update the `parseJobsEnv` test that expects no mail transport locally.

The wrangler `e2e` environment never takes the binding: it sends to the fake provider's mailbox through `MAIL_CAPTURE_URL`.

`PUBLIC_BASE_URL` (step 6) and `MAIL_FROM` are plain vars in `apps/jobs/wrangler.jsonc`. The jobs Worker checks both at startup: `PUBLIC_BASE_URL` must be https in production, and `MAIL_FROM` is `name@domain` or `Display Name <name@domain>`. Claim links point at `PUBLIC_BASE_URL`, so it must be the web Worker's public origin.

## Paddle

Each creator connects their own Paddle account from the Billing page; ShareRepo needs no Paddle account of its own. Production accepts only live API keys, and dev only sandbox keys. A creator's webhook destination is `<BETTER_AUTH_URL>/webhooks/paddle/<connectionId>`, so attaching a new domain means every creator must reconnect to move their destination. Before Phase 5 merges, run the live check in the [Paddle sandbox runbook](runbooks/paddle-sandbox-setup.md).

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
