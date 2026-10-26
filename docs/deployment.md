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
   - `CLAIM_SIGNING_KEY`: signs checkout claim references and hashes claim emails and IPs. Either a plain-text key of at least 32 bytes (the Phase 5 format, below), or a keyring in the same shape as `CREDENTIAL_KEYS`, `{"current":"c1","keys":{"c1":"<base64 of at least 32 bytes>"}}`. A plain-text key is the keyring's only key. Rotation needs the keyring ([secret rotation](runbooks/secret-rotation.md) § 2 converts one to the other).

   ```sh
   node -e 'console.log(JSON.stringify({current: "k1", keys: {k1: require("node:crypto").randomBytes(32).toString("base64")}}))' > keyring.json
   openssl rand -hex 32 > claim-key.txt
   for app in web jobs; do
     (cd apps/$app && pnpm exec wrangler secret put CREDENTIAL_KEYS < ../../keyring.json \
       && pnpm exec wrangler secret put CLAIM_SIGNING_KEY < ../../claim-key.txt)
   done
   # and again with --env production, with new values
   ```

   Store both in the password manager, then delete the files. Treat `CREDENTIAL_KEYS` like the GitHub App private key: losing it makes every stored Paddle credential unreadable, and every creator must reconnect. Rotate either one with the [secret rotation runbook](runbooks/secret-rotation.md): add the new key to both Workers, make it current, and remove the old key only when the runbook says so. Replacing `CLAIM_SIGNING_KEY` outright, without the keyring, invalidates open checkout claims; claim links already sent keep working.

10. Create the queues that carry webhook work from web to jobs, and their dead-letter queues ([decision 0014](decisions/0014-failure-handling-and-alerting.md)):

   ```sh
   pnpm --filter @sharerepo/web exec wrangler queues create sharerepo-events-dev
   pnpm --filter @sharerepo/web exec wrangler queues create sharerepo-events-dlq-dev
   pnpm --filter @sharerepo/web exec wrangler queues create sharerepo-events-prod
   pnpm --filter @sharerepo/web exec wrangler queues create sharerepo-events-dlq-prod
   ```

   Cloudflare creates a missing dead-letter queue on its own; creating it explicitly makes the setup the same in both environments. See § Queues for how they are used.

11. List the **operators** ([decision 0014](decisions/0014-failure-handling-and-alerting.md)): set `OPERATOR_GITHUB_IDS` in `apps/web/wrangler.jsonc` (top level for dev, `env.production` for production) to the operators' GitHub account IDs, comma-separated. These are the immutable numeric IDs, never logins (`gh api users/<login> --jq .id`). They are not secret, so they are committed. Empty means no operators: `/ops` answers 404 to everyone. A value that is not a comma-separated list of numbers is a configuration error: the web Worker fails closed, as for a malformed secret, and the `/readyz` smoke test fails. The jobs Worker does not read it.
12. Set up alerting: Workers Issues automations and the two Monitors, by the [alerting setup runbook](runbooks/alerting-setup.md). They are configured by hand in the Cloudflare dashboard, because Wrangler cannot configure them yet.
13. Set the repository variable `DEPLOY_ENABLED` to `true`. Until then, CI runs every check but skips deployment.

ShareRepo-owned secrets are added with `wrangler secret put <NAME> [--env production]`, never committed; `secrets.required` in `wrangler.jsonc` lists them. One secret is optional and not listed: `GITHUB_WEBHOOK_SECRET_PREVIOUS` on the web Worker, set only while the GitHub webhook secret is being rotated ([secret rotation](runbooks/secret-rotation.md) § 3). While it is set, webhooks signed with either secret are accepted. Local values go in `apps/*/.dev.vars`, which is gitignored. The wrangler `e2e` environment is for local Playwright runs only and is never deployed; a test fails if CI ever selects it.

## Queues

| Queue | Producer | Consumer | Settings |
|---|---|---|---|
| `sharerepo-events-<env>` | web and jobs (`EVENTS`) | jobs | `max_batch_size` 10, `max_retries` 5, dead-letter queue `sharerepo-events-dlq-<env>` |
| `sharerepo-events-dlq-<env>` | Cloudflare only (no binding) | jobs | `max_batch_size` 10, `max_retries` 5 |

- A message is one outbox row by ID (decision 0003). The outbox drain runs every row the queue does not finish.
- A retryable failure is retried on the queue with backoff. From the fifth delivery (`QUEUE_MAX_RETRIES` in `apps/jobs/src/handlers.ts`, which a test keeps equal to `max_retries`) the consumer hands the row to the drain's longer backoff instead. So only a consumer that crashes or times out on every delivery sends a message to the dead-letter queue.
- The dead-letter consumer never runs the job. It marks a matching, still-open outbox row failed with `dead_lettered`, writes `job.failed` and logs the `job_failed` alert line ([failure triage](runbooks/failure-triage.md#the-dead-letter-queue)).
- `<env>` is `dev` or `prod`. The `e2e` environment uses the dev queue names locally.

## Scheduled work

The jobs Worker's crons (`triggers.crons` in `apps/jobs/wrangler.jsonc`, the same in every environment):

| Cron | What it does |
|---|---|
| `* * * * *` | The minute tick. Queues up to 100 subscriptions whose next policy boundary passed, and up to 100 due repository checks (at most 10 per GitHub installation, none for an installation that is rate limited). Drains the outbox for about 20 seconds. Then stores and logs the `sweep.heartbeat` line, and raises `sweep_lagging` when the oldest due row is more than 15 minutes late (at most once per 15 minutes). Each step runs even when another fails. |
| `17 3 * * *` | The daily tick. Queues a Paddle sweep per active Paddle connection; a `rewrap_credentials` run while any envelope is under a retired `CREDENTIAL_KEYS` key; a resync of every GitHub connection that is not deleted; and the data lifecycle: one `prune_data` and a `purge_workspace` per workspace whose deletion is due ([decision 0015](decisions/0015-data-lifecycle.md)). Every row except the rewrap is delayed by `dailyOffsetMs` (a hash of its kind and subject, under 24 hours), so the day's provider calls are spread over the day rather than made at 03:17. |
| `0 * * * *` | Logs `scheduled heartbeat`. Nothing else. |

The minute and daily ticks do nothing, heartbeat included, while `GITHUB_APP_ID` is empty on the jobs Worker. Timers stay in the database: there are no Cloudflare Workflows ([decision 0013](decisions/0013-database-timers-and-expiry-confirmation.md)).

## Observability and alerts

- **Workers Logs** is on for both Workers. Every line is JSON with a correlation ID, and carries IDs and classified codes, never secrets or personal data.
- **Workers Issues** is on for both Workers in every environment (`observability.issues.enabled: true`). Each environment block repeats it, because a deploy without it turns Issues off.
- **Alert lines** (`alert: <name>`) and the minute heartbeat feed two Cloudflare Monitors that email the operator. Both are configured by hand: [alerting setup](runbooks/alerting-setup.md).
- **`/ops`** shows every workspace's failures and the sweep's health, for operators only. Until Monitors leaves beta, review it daily.

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
- **Data:** D1 Time Travel can restore a database to a point in time (`wrangler d1 time-travel restore`). Treat this as an incident procedure; it discards later writes. Follow [backup and restore](runbooks/backup-and-restore.md), and read [incident response](runbooks/incident-response.md) § Restoring D1 for what a restore loses.

## First-deploy checks

These need a deployed environment and have not been run yet. Run them in dev after the first deploy that includes Phase 6, then in production, and record the date and result here. The steps are in [alerting setup](runbooks/alerting-setup.md) § 5.

| Check | dev | production |
|---|---|---|
| Both queues and their dead-letter queues exist; the events queue names its dead-letter queue; the jobs Worker consumes both | not run | not run |
| A message on the dead-letter queue is consumed and logged | not run | not run |
| Workers Issues lists both Workers, and its automation notifies the operator | not run | not run |
| An alert line reaches the operator by email | not run | not run |
| The heartbeat Monitor counts the minute heartbeat | not run | not run |
| `/ops` loads for an operator and answers 404 to anyone else | not run | not run |
| `pnpm db:drill --remote` passes against the environment's database ([backup and restore](runbooks/backup-and-restore.md)) | not run | not run |
| An in-place Time Travel restore and its order of operations, rehearsed on dev only | not run | — |
| Each section of [secret rotation](runbooks/secret-rotation.md) rehearsed | not run | — |

## Runbooks

- [Incident response](runbooks/incident-response.md): triage, severity, access loss, leaked secrets, restores, a workspace deletion that waits.
- [Failure triage](runbooks/failure-triage.md): `/ops`, the Access page's failures, error codes, retry or dismiss, the dead-letter queue, alerts.
- [Alerting setup](runbooks/alerting-setup.md): Workers Issues, the Monitors, email, first-deploy checks.
- [Backup and restore](runbooks/backup-and-restore.md): the drill, a real restore.
- [Secret rotation](runbooks/secret-rotation.md): every ShareRepo and tenant secret.
- [GitHub App setup](runbooks/github-app-setup.md) and [Paddle sandbox setup](runbooks/paddle-sandbox-setup.md).

## Manual deploy (emergency only)

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
pnpm db:migrate:dev
pnpm --filter @sharerepo/jobs run deploy
pnpm --filter @sharerepo/web build && pnpm --filter @sharerepo/web run deploy
```

For production, add `--env production` to the jobs deploy, build web with `CLOUDFLARE_ENV=production`, and use `pnpm db:migrate:prod`.
