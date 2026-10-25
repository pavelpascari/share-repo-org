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
cp apps/web/.dev.vars.example apps/web/.dev.vars   # then fill in, see below
pnpm db:migrate:local      # apply migrations to the local D1 used by `pnpm dev`
pnpm dev                   # web on http://localhost:5173, with the jobs Worker in the same runtime
```

### Signing in locally

The web Worker refuses to start requests without its auth configuration ([decision 0006](decisions/0006-authentication-with-better-auth.md)). `apps/web/.dev.vars` (gitignored) needs:

- `BETTER_AUTH_SECRET`: any random value of at least 32 characters (`openssl rand -base64 32`).
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: from your own GitHub OAuth App (GitHub → Settings → Developer settings → OAuth Apps) with the callback URL `http://localhost:5173/api/auth/callback/github`. No scopes are requested.

### Connecting GitHub locally (optional)

Connecting GitHub needs a development GitHub App: follow [the runbook](runbooks/github-app-setup.md) and add its values to `apps/web/.dev.vars` and `apps/jobs/.dev.vars`. Without them the Repositories page says GitHub is not configured; everything else works.

### Simulated billing (Phase 3)

Outside production, each workspace has a **Simulator** page ([decision 0009](decisions/0009-entitlement-policy-v1.md)). It stands in for Paddle, so you can try offers and access before Phase 5:

1. Connect GitHub (above) so repositories exist.
2. On **Offers**, create an offer: pick repositories, set a grace period, and give it a commercial item ID such as `sim_monthly`.
3. On **Simulator**, add a subscriber by GitHub login with that item ID, then drive their subscription: activate, mark past due, cancel, expire, reactivate.
4. On **Access**, see each subscriber and repository: the desired access, what GitHub shows, and what ShareRepo will do next.

Simulator actions are processed by the jobs Worker, which `pnpm dev` runs alongside the web Worker. In production the Simulator page and its jobs are disabled.

### GitHub provisioning (Phase 4)

With a connected development App, simulated subscriptions change real access on your test repository ([decision 0010](decisions/0010-grant-ownership-and-reconciliation.md)):

- **Activating a subscriber** invites their GitHub account. GitHub emails them the invitation, and the Access page shows "Invitation sent" until they accept.
- **Ending a subscription** removes the collaborator, or cancels the pending invitation, but only if ShareRepo created it. Someone you added by hand is shown as "Has access ShareRepo does not manage" and left alone.
- **Checks run on a schedule.** ShareRepo checks each repository again every 15 minutes while anything is pending, and every 6 hours otherwise. Owners can press **Check now** on a repository, and **Retry** on a row with an error.
- **Each repository is limited to 40 ShareRepo invitations per 24 hours**, below GitHub's 50. Past that, invitations wait, and the Access page says the limit was reached. The next check after the 24-hour window opens sends them.

Use a test repository and test accounts only: invitations are real and count against GitHub's limits.

### Paddle and purchase claims (Phase 5)

Paddle needs two ShareRepo secrets ([decision 0011](decisions/0011-paddle-connection-and-tenant-credentials.md), [decision 0012](decisions/0012-purchase-claims.md)). Without them the Billing page says Paddle is not configured, and everything else works. Put the same values in `apps/web/.dev.vars` and `apps/jobs/.dev.vars`, which share one database:

```sh
# The master keyring for stored Paddle credentials:
node -e 'console.log("CREDENTIAL_KEYS=" + JSON.stringify({current: "k1", keys: {k1: require("node:crypto").randomBytes(32).toString("base64")}}))'
# The key that signs claim references and hashes claim emails:
echo "CLAIM_SIGNING_KEY=$(openssl rand -hex 32)"
```

There are two ways to try Paddle locally:

- **Against the fake, with nothing to set up.** `node apps/web/e2e/support/serve.ts` starts the E2E stack: web and jobs on <http://localhost:5180> with a fresh database, the fake GitHub on port 5190 and the fake Paddle on port 5191. It generates its own secrets. Sign in through the fake GitHub's authorize page with any ID and login. Register a seller and a price (below), then connect with that key on Billing. The stack wipes its database on every start.
- **Against Paddle's sandbox.** Follow [the sandbox runbook](runbooks/paddle-sandbox-setup.md). `pnpm dev` talks to `sandbox-api.paddle.com`; Paddle's webhooks need a tunnel.

Claiming by email needs a mail transport. Locally only the E2E stack has one: the fake Paddle's mailbox.

#### The fake Paddle's controls

The fake (`apps/web/e2e/support/fake-paddle.ts`) serves the API ShareRepo calls under `/api`, a default payment link page at `/pay?_ptxn=<txn>`, and these controls. Controls take a form or JSON body and answer JSON.

| Control | What it does |
|---|---|
| `POST /_control/sellers` (`key`, optional `name`, `permissions`) | Registers a seller behind an API key, for example `pdl_sdbx_apikey_` + 26 lower-case letters or digits + `_` + 22 letters or digits + `_` + 3. Returns `sellerId`. `permissions` (comma-separated) defaults to all ShareRepo needs |
| `POST /_control/sellers/<sellerId>/prices` (`product_name`, `description`, `amount` in minor units, `currency`, `interval`, `frequency`) | Adds a price to the seller's catalog |
| `POST /_control/sellers/<sellerId>/transactions` (`price_id`, optional `custom_data` JSON) | A checkout as if shared from Paddle directly, without a ShareRepo reference. Returns `checkout_url` |
| `POST /_control/sellers/<sellerId>/revoke-key`, `…/restore-key` | Every call with the key fails with `403`, until restored |
| `POST /_control/sellers/<sellerId>/fail-next` (`operation`, `kind`) | The seller's next call of `operation` (a Paddle port operation such as `getSubscription` or `deleteNotificationSetting`) fails with `kind` (`rejected`, `transient`, `not_found`, `rate_limited`, `unauthorized`), doing nothing |
| `POST /_control/sellers/<sellerId>/events` (`event_type`, and `subscription_id` or `data` JSON) | Sends any signed event to the seller's destinations; with `subscription_id`, carrying the subscription as it is now, as Paddle's retry of a lost delivery does |
| `GET /_control/sellers/<sellerId>` | The seller's subscriptions (wire format), destinations and webhook deliveries with their status |
| `POST /_control/subscriptions/<id>/<action>` | Changes a subscription and sends Paddle's event for it. Actions: `schedule-cancel` (`effective_at`, or `effective_in_seconds`; within 10 minutes the fake cancels by itself then), `remove-scheduled-change`, `cancel`, `past-due`, `renew`, `activate`, `pause`, `resume`. Also `lose-webhooks` and `deliver-webhooks`: while lost, the subscription's changes apply (a scheduled cancellation too) but no webhook is delivered |
| `GET /_control/mail?to=<address>` | The claim emails ShareRepo sent, captured at `POST /mail` |

"Pay" on the payment link page creates the customer by email, or reuses the one with that exact email as Paddle does. It creates the subscription with the transaction's custom data, then sends signed `transaction.completed`, `subscription.created` and `subscription.activated` webhooks.

Paddle's events reach ShareRepo through the queue, and so does the refresh each one asks for. The dev server runs no crons, so a reconciliation starts only when an owner presses **Check now**, as in Phase 4, and nothing the minute sweep or the outbox drain would do (a due subscription check, a workspace deletion's refreshes) happens by itself.

### Operations pages (Phase 6)

`/ops` answers 404 unless your GitHub account ID is listed in `OPERATOR_GITHUB_IDS`. For `pnpm dev`, add `OPERATOR_GITHUB_IDS=<your numeric GitHub ID>` to `apps/web/.dev.vars`. The E2E stack lists one operator, ID `3000000001` (`OPERATOR_GITHUB_ID` in `apps/web/e2e/support/ports.ts`): sign in through the fake GitHub with that ID to open `/ops`. To see a failure there, make the fake Paddle refuse a subscription read (`fail-next` with `getSubscription` and `rejected`), then send an event for the subscription.

Tests never need these values. Workers-pool tests use test-only secrets from `apps/web/vitest.config.ts`, and `pnpm test:e2e` signs in through a local fake GitHub (`apps/web/e2e/support/fake-github.ts`) and sells through the fake Paddle, with the wrangler `e2e` environment, which is the only one that accepts provider endpoint overrides.

pnpm blocks dependency build scripts by default; `pnpm-workspace.yaml` allows only `workerd` and `esbuild`, which the Workers runtime needs.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | React Router app and HTTP entry Worker (`workers/app.ts`) |
| `apps/jobs` | Background Worker: crons, the events queue and its dead-letter queue |
| `packages/domain` | Pure domain rules and ports (`Clock`, `IdGenerator`); mutation-tested |
| `packages/db` | Drizzle schema, SQL migrations, workspace-scoped repositories |
| `packages/platform` | Env parsing, structured logging with redaction, correlation IDs, error types |
| `packages/application` | Application services: sign-in recording, workspaces, GitHub connections and resync, authorization, audit |
| `packages/integrations` | GitHub App client (JWT, installation tokens, webhooks), Paddle client and webhook verification, the mail port; fakes under `@sharerepo/integrations/testing` |
| `packages/testing` | Test helpers: fake clock, deterministic IDs, log capture, secret canaries, audit completeness |
| `scripts` | Coverage ratchet, scenario-catalog check and the D1 backup and restore drill |

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the web Worker with the jobs Worker as an auxiliary Worker, sharing local D1 and the `EVENTS` queue. `pnpm --filter @sharerepo/jobs dev` runs jobs alone, with crons triggerable at `/__scheduled`. |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | Wrangler type drift check, React Router typegen, `tsc` for every package |
| `pnpm test` | Every Vitest project (Node and Workers runtimes) |
| `pnpm test:coverage` | Tests with merged coverage, then raises committed thresholds in `coverage-thresholds.json` |
| `pnpm test:mutation` | Stryker on `packages/domain` (slow; run when domain changes) |
| `pnpm test:e2e` | Playwright against both Workers, a fresh local D1, the fake GitHub and the fake Paddle. The server is warmed up before the tests start |
| `pnpm check:scenarios --phase <n>` | Fails if a scenario due by phase `n` in `docs/testing-strategy.md` has no test |
| `pnpm db:generate` | Generate a SQL migration from schema changes in `packages/db/src/schema` |
| `pnpm db:check` | Fails if the schema and committed migrations disagree |
| `pnpm db:drill` | Backup and restore drill: exports a copy of the local D1, restores it into a fresh local D1, applies pending migrations, and checks rows, indexes, triggers, the migrations table, `PRAGMA quick_check` and `PRAGMA foreign_key_check`. `--persist-to .e2e/state` drills the last E2E run's database, which has data; `--keep` keeps the scratch directory. See [backup and restore](runbooks/backup-and-restore.md) |
| `pnpm build` | Build both Workers |
| `pnpm spike:github` | Live GitHub feasibility spike against your development App ([runbook](runbooks/github-app-setup.md) § 6); never runs in CI |

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
- **`pnpm test:e2e` fails before any test runs:** another process holds port 5180, 5190 or 5191 (often a stopped run's `serve.ts`). The suite always starts its own servers; stop the old ones.
- **Local D1 state looks wrong:** delete `apps/web/.wrangler` and run `pnpm db:migrate:local` again.
- **Every page returns 500 locally with "invalid environment configuration":** `apps/web/.dev.vars` is missing or incomplete; see [Signing in locally](#signing-in-locally).
- **Writing a service:** take a `ServiceContext`, authorize with `openWorkspace` (which returns a `WorkspaceScope`), and pass audit events to the repository write so they share its batch. Wrap service tests in `expectAuditedChange` / `expectNoChangeOnFailure` from `@sharerepo/testing`.
