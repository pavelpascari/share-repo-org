# Runbook — rotating secrets

Every ShareRepo and tenant secret can be rotated without downtime. This runbook takes each row of the [Phase 6 plan](../plans/phase-6.md) § Secret rotation in turn. Background: [decision 0011](../decisions/0011-paddle-connection-and-tenant-credentials.md) (`CREDENTIAL_KEYS`, Paddle secrets), [decision 0012](../decisions/0012-purchase-claims.md) and its rotation amendment (`CLAIM_SIGNING_KEY`), the [operations threat model](../security/operations-threat-model.md) (O15–O17), and [deployment](../deployment.md) § One-time setup for how each secret was first set.

**Status:** draft from Phase 6 T5. The code paths are tested; no step has been rehearsed against a deployed environment yet. T7 rehearses them in dev.

## Before any rotation

- Rotate in **dev first**, then production (`--env production` on every `wrangler` command).
- Generate new values on a trusted machine, put them in the password manager, and delete any file you wrote them to.
- Never paste a secret into a ticket, a chat, a shell history that is synced, or a log. Use `wrangler secret put <NAME> < file` or the interactive prompt.
- `wrangler secret put` deploys a new version of the Worker at once. **Secrets are per Worker.** `CREDENTIAL_KEYS`, `CLAIM_SIGNING_KEY` and `GITHUB_APP_PRIVATE_KEY` live on both Workers (`apps/web`, `apps/jobs`), so between the two `put`s the Workers run with different values. The procedures below are written so that window is safe.
- After each step, check the web Worker's `GET /readyz` and the jobs Worker's logs (Workers Logs) for configuration errors. Both Workers fail closed on a malformed value, so a typo shows up at once, not later.

| Secret | Where | Mechanism | Downtime |
|---|---|---|---|
| `CREDENTIAL_KEYS` | web, jobs | Keyring; `rewrap_credentials` job | None |
| `CLAIM_SIGNING_KEY` | web, jobs | Keyring; every key verifies | None |
| `GITHUB_WEBHOOK_SECRET` | web | `GITHUB_WEBHOOK_SECRET_PREVIOUS` | None |
| `GITHUB_APP_PRIVATE_KEY` | web, jobs | GitHub allows two active keys | None |
| Paddle webhook secret | per connection | Billing page action | None |
| Paddle API key | per connection | Reconnect | None |
| `BETTER_AUTH_SECRET` | web | Replace | Everyone is signed out |

## 1. `CREDENTIAL_KEYS` (master keys for tenant credentials)

The keyring is `{"current":"k1","keys":{"k1":"<base64 of 32 bytes>"}}`. `current` seals new envelopes; every listed key opens envelopes it sealed. Envelopes record their key ID.

1. **Generate the new key** and write the *transition keyring*: the old keys plus the new one, with `current` **unchanged**.

   ```sh
   node -e 'const c=require("node:crypto");console.log(c.randomBytes(32).toString("base64"))'
   # keyring-a.json: {"current":"k1","keys":{"k1":"<old>","k2":"<new>"}}
   ```

2. **Add the key to both Workers.** Neither seals with `k2` yet, so the order does not matter.

   ```sh
   for app in jobs web; do
     (cd apps/$app && pnpm exec wrangler secret put CREDENTIAL_KEYS < ../../keyring-a.json)
   done
   ```

3. **Make the new key current on both Workers** (`keyring-b.json`: the same keys, `"current":"k2"`), with the same loop. Between the two `put`s one Worker seals under `k2` and the other under `k1`; both Workers can open both, so nothing breaks. Do not skip step 2: a Worker that seals under a key the other Worker lacks writes envelopes the other cannot open.
4. **Move every envelope off the old key.** Envelopes are re-wrapped lazily when they are used, and the jobs Worker's daily cron (`17 3 * * *`) queues a `rewrap_credentials` run whenever an envelope is still under a listed key other than `current`. Each run re-wraps up to 50 envelopes (Paddle API keys, webhook secrets, a rotation's next webhook secret, pending claim request emails) and queues the next run while work remains. Each run writes an account-scoped audit event `credentials.rewrapped` with `rewrapped`, `failed` and `remaining`.
5. **Confirm that nothing references the old key.** Wait for a `credentials.rewrapped` event with `remaining: 0`, then check directly:

   ```sh
   pnpm --filter @sharerepo/db exec wrangler d1 execute <database> --remote --command "
     SELECT 'paddle api_key', count(*) FROM paddle_connections WHERE json_extract(api_key_envelope, '$.kid') = 'k1'
     UNION ALL SELECT 'paddle webhook_secret', count(*) FROM paddle_connections WHERE json_extract(webhook_secret_envelope, '$.kid') = 'k1'
     UNION ALL SELECT 'paddle webhook_secret_next', count(*) FROM paddle_connections WHERE json_extract(webhook_secret_next_envelope, '$.kid') = 'k1'
     UNION ALL SELECT 'claim emails', count(*) FROM claim_requests WHERE json_extract(email_envelope, '$.kid') = 'k1'"
   ```

   Every count must be 0. If `failed` was above 0, an envelope did not open under its own key: it was tampered with or copied to another row. Do not remove the key; treat it as an incident and find the row with the query above.
6. **Remove the old key** from both Workers (`{"current":"k2","keys":{"k2":"<new>"}}`), with the same loop. Removing it early makes the envelopes it sealed unreadable: those creators must reconnect Paddle, and pending claim emails are lost.
7. Delete the old key from the password manager only after the next daily cron logs `credential rewrap check` with `queued: false`.

To start step 4 before the next daily cron, queue the first run by hand; the minute's outbox drain picks it up:

```sh
pnpm --filter @sharerepo/db exec wrangler d1 execute <database> --remote --command "
  INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts)
  VALUES (lower(hex(randomblob(16))), 'rewrap_credentials', 'rewrap:0',
          unixepoch('subsec') * 1000, unixepoch('subsec') * 1000, 0)"
```

If the old key **leaked**, do steps 1–6 at once, starting step 4 by hand. The leaked key alone opens nothing without a copy of the database, but if both may have leaked, treat every tenant credential as compromised: ask creators to reconnect with new Paddle API keys (§ 6) and rotate their webhook secrets (§ 5).

## 2. `CLAIM_SIGNING_KEY` (claim references, email and IP hashes)

It accepts the Phase 5 plain-text key, or a keyring `{"current":"c2","keys":{"c1":"<base64>","c2":"<base64>"}}` of keys of at least 32 bytes. A plain-text key is the keyring's only key. The current key signs new checkout references and computes the email and IP hashes; every listed key verifies references, and the rate-limit counters kept under each listed key count towards the same limits ([decision 0012 amendment](../decisions/0012-purchase-claims.md#amendment--rotating-claim_signing_key-phase-6-t5)).

1. **Convert the current value to a keyring** without changing what it signs. The keyring holds key bytes as base64, and a plain-text key's bytes are its UTF-8 text:

   ```sh
   printf %s '<the current plain-text key>' | base64          # → <old as base64>
   openssl rand -base64 32                                     # → <new>
   # claim-a.json: {"current":"c1","keys":{"c1":"<old as base64>","c2":"<new>"}}
   ```

   If you are not sure whether the stored plain-text value ended with a newline, list both spellings as two keys (`c1` without, `c1n` with: `printf '%s\n' … | base64`). An extra key only accepts what the same secret signed.
2. **Put the transition keyring on both Workers**, `current` still the old key:

   ```sh
   for app in jobs web; do
     (cd apps/$app && pnpm exec wrangler secret put CLAIM_SIGNING_KEY < ../../claim-a.json)
   done
   ```

   Check that checkout still starts, and that a test claim request is accepted.
3. **Make the new key current on both Workers** (`claim-b.json`, `"current":"c2"`). During the window, references signed by either Worker verify on both.
4. **Keep the old key listed for at least 8 days:** a checkout claim lives 7 days, and the longest rate-limit window is a day. Until then, a buyer who started checkout under the old key still gets linked when they pay.
5. **Remove the old key** from both Workers (`{"current":"c2","keys":{"c2":"<new>"}}`). After that:
   - a reference only the old key signed no longer verifies (`claim.rejected`, `signature_invalid`); by then its checkout claim has expired anyway;
   - renewals of customers it already linked are not checked again: a claim the customer already used needs no MAC;
   - rate-limit counters kept under the old key stop counting. They were older than every window by then.
   - Claim links already emailed keep working: they are random tokens, not MACs.

If the old key **leaked**, skip the wait in step 4: an attacker who holds it can forge a reference for any checkout claim ID they learn, binding a purchase to someone else's account, and can compute email hashes. Accept that buyers with checkouts open under the old key must claim by email (path 2) instead.

## 3. `GITHUB_WEBHOOK_SECRET`

Only the web Worker verifies GitHub webhooks. While `GITHUB_WEBHOOK_SECRET_PREVIOUS` is set, a delivery signed with either secret is accepted (constant-time, on the raw body).

1. Generate the new secret: `openssl rand -hex 32`.
2. **Keep the old secret as the previous one**, then set the new one:

   ```sh
   cd apps/web
   pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET_PREVIOUS   # the current value
   pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET            # the new value
   ```

3. In the GitHub App's settings (**General › Webhook secret**), enter the new secret and save.
4. Under **Advanced › Recent deliveries**, check that new deliveries are answered `202`. Redeliver one older delivery to confirm the route still answers.
5. **Remove the previous secret** once the new one works, within the hour:

   ```sh
   pnpm exec wrangler secret delete GITHUB_WEBHOOK_SECRET_PREVIOUS
   ```

   While it is set, a leaked old secret still signs valid webhooks (threat O15). Webhooks only trigger a re-read of GitHub, so a forged one cannot grant access, but end the window promptly. A missed delivery is repaired by the daily resync.

## 4. `GITHUB_APP_PRIVATE_KEY`

Both Workers sign GitHub App JWTs. GitHub allows several private keys per App, all valid until deleted.

1. In the GitHub App's settings (**General › Private keys**), **Generate a private key**. Keep the old one for now.
2. Convert it to PKCS#8 as in the [GitHub App runbook](github-app-setup.md) § 3, step 3.
3. Put it on both Workers:

   ```sh
   for app in jobs web; do
     (cd apps/$app && pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < ../../app.pkcs8.pem)
   done
   ```

4. Check that it works: open a workspace's Repositories page and refresh the repository list, and look for `outbox drained` in the jobs Worker's logs without GitHub `unauthorized` errors.
5. **Delete the old key** in the GitHub App's settings. Delete the PEM files.

If the key leaked, do the same at once: deleting it in GitHub ends it everywhere.

## 5. Paddle webhook secret (per connection)

Paddle cannot rotate a destination's secret. The workspace owner rotates it from the **Billing** page with **Rotate webhook secret**:

1. ShareRepo creates a second destination for the same connection, its URL marked `?v=<id>` (Paddle refuses two destinations with the same URL; the webhook route reads the connection from the path only). It stores the new destination's ID and secret (sealed for `webhook_secret_next`) and records `paddle.webhook_secret_rotated` with `stage: started`. From then on deliveries signed with either secret are accepted, and Paddle sends every event to both destinations; the second copy is a duplicate by event ID.
2. ShareRepo deletes the old destination in Paddle, promotes the new destination and secret, and records `stage: completed`. Only the new secret is accepted afterwards.

Every step leaves at least one destination delivering. If Paddle fails part-way, the page says Paddle didn't respond and shows **A rotation is in progress**; pressing the button again continues where it stopped. Operators need to know three cases:

- **"Already has 10 active notification destinations".** Nothing changed. The creator deletes a destination they no longer use in Paddle (**Developer tools › Notifications**) and rotates again.
- **A lost response while creating the second destination.** Paddle created it, but ShareRepo never learned its ID, so it stored nothing. The next rotation creates another. The lost destination is left in Paddle, delivering to the connection's URL with a secret ShareRepo does not know (`401`), and uses one of the 10 slots. In Paddle, delete the destination whose URL has a `?v=` marker that is neither the connection's current destination nor its pending one (the Billing page shows the current destination ID).
- **Disconnecting during a rotation** deletes both destinations and erases both secrets. If Paddle cannot be asked, the page lists both destination IDs for the creator to delete by hand.

The daily Paddle sweep repairs any event lost while the old destination was being deleted (events Paddle had queued for retries to it).

## 6. Paddle API key (per connection)

A creator replaces the key with **Reconnect** on the Billing page ([decision 0011](../decisions/0011-paddle-connection-and-tenant-credentials.md)): create a new key in Paddle with the same permissions, reconnect with it and its expiry date, then revoke the old key in Paddle. The new key must belong to the same seller. The destination and its secret stay.

## 7. `BETTER_AUTH_SECRET`

Rotating it signs everyone out: session cookies and Better Auth's verification values are signed with it ([decision 0006](../decisions/0006-authentication-with-better-auth.md)). No access changes, no data is lost, and sign-in works at once with the new value.

1. Pick a quiet time and, for production, warn creators.
2. `openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET` from `apps/web`.
3. Sign in again and check a workspace page loads. Sign-ins that were half-way through the GitHub redirect fail once and work on retry.

If it leaked, rotate at once and handle it as a credential leak (incident response).
