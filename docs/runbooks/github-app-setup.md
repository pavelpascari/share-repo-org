# Runbook — development GitHub App and live test accounts

These steps are for live use and for the Phase 2 feasibility spike. Tests and `pnpm test:e2e` never need them: they run against fakes.

## 1. Accounts and a test repository

1. Your **creator** account: your personal GitHub account.
2. A **subscriber** account: a second GitHub account you control (GitHub allows one free account per person for testing; use a different email). Note its username.
3. On the creator account, create a **private** repository for testing, for example `sharerepo-test`. Put a README in it and nothing secret.

## 2. Expose your local web Worker (for webhooks)

GitHub must reach your webhook URL. With `pnpm dev` running:

```sh
cloudflared tunnel --url http://localhost:5173
```

Note the `https://<random>.trycloudflare.com` URL; it changes on every run. Update the App's webhook URL (step 3) whenever it changes. The setup callback can stay on `http://localhost:5173`, because your browser follows it.

## 3. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Field | Value |
|---|---|
| Name | `ShareRepo Dev (<your login>)`. Names are global. |
| Homepage URL | `http://localhost:5173` |
| Callback URL | leave empty: sign-in uses the separate OAuth App from Phase 1 |
| Request user authorization during installation | **off** |
| Setup URL | `http://localhost:5173/github/setup`, with **Redirect on update** on |
| Webhook | Active; URL `https://<tunnel>/webhooks/github` |
| Webhook secret | `openssl rand -hex 32`. Keep it for step 5. |
| Repository permissions | **Administration: Read and write**; **Metadata: Read-only** (mandatory) |
| Organization and account permissions | none |
| Subscribe to events | **Repository**. Installation events are always delivered. |
| Where can this GitHub App be installed? | **Only on this account** |

Then:

1. Note the **App ID** and the **slug**, the last part of the App's public URL `github.com/apps/<slug>`.
2. **Generate a private key.** A `.pem` file downloads.
3. Convert the key to PKCS#8. Workers' WebCrypto cannot read GitHub's PKCS#1 format:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/<app>.private-key.pem -out sharerepo-dev.pkcs8.pem
   ```

   Store the original and the converted key in your password manager, and delete the downloaded copy.

## 4. Do not install yet

Install from ShareRepo (Workspace → Repositories → **Connect GitHub**) so the installation is bound to your workspace. Installing directly on GitHub works, but ShareRepo will not attach it until you connect from the app.

## 5. Local configuration

Add the following to both `apps/web/.dev.vars` and `apps/jobs/.dev.vars`. These files are gitignored; never commit them.

```sh
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=sharerepo-dev-yourlogin
GITHUB_WEBHOOK_SECRET=<from step 3>
# The PKCS#8 key on one line, with literal \n between lines:
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

To produce the one-line form: `awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' sharerepo-dev.pkcs8.pem`.

## 6. Run the feasibility spike

Install the App on the test repository only (step 4, or directly on GitHub for the spike). The spike reads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` from `apps/web/.dev.vars` (step 5), or from the environment if set there.

First a dry run, which only reads and checks that it is safe to proceed:

```sh
SPIKE_REPO=<your-login>/sharerepo-test SPIKE_SUBSCRIBER=<subscriber-login> pnpm spike:github
```

It refuses to continue if the repository is public, is not owned by your personal account, the installation is suspended or on another account, or the subscriber is the owner. Then run it for real:

```sh
SPIKE_REPO=<your-login>/sharerepo-test SPIKE_SUBSCRIBER=<subscriber-login> pnpm spike:github --yes
```

With `--yes`, the spike:

- removes any existing invitation or access for the subscriber;
- invites the subscriber with `permission=pull`, observes what GitHub recorded, removes them as a collaborator while the invitation is pending, observes again, and cancels the invitation;
- invites again without a permission, observes, and cancels;
- checks the repository is left with no invitation and no access for the subscriber;
- writes the observations and conclusions to `docs/research/github-live-results.md`, keeping that file's manual checklist.

It uses two of the repository's 50 invitations per 24 hours, and the subscriber gets two invitation emails. It never prints the private key, the App JWT or installation tokens. If it stops halfway, run it again: it cleans up first.

Then complete the manual checklist at the end of that file (invitation email, `member` webhook after accepting an invitation by hand, push access after acceptance, branch protection on your plan, clean-up), and commit the file.

## 7. Before merging Phase 4: live provisioning check

Phase 4 is built on the safe assumptions in [decision 0010](../decisions/0010-grant-ownership-and-reconciliation.md). Before it merges, run the spike (step 6) and record the results. Then check the whole flow once against the test repository with `pnpm dev`:

1. Create an offer for the test repository. In the Simulator, add the subscriber account and activate it. On Access, the row shows "Invitation sent", and GitHub shows a pending invitation.
2. Accept the invitation as the subscriber, then press **Check now**. The row shows "Active".
3. Remove the subscriber by hand on GitHub, then press **Check now**. ShareRepo invites them again, because the subscription is live.
4. Cancel the subscription now in the Simulator. ShareRepo removes the collaborator, or cancels the invitation. After the next check, the row shows "Removed".
5. Add a second account by hand as a collaborator, then simulate a subscription for it and cancel it. That account keeps its access, and the row shows "Has access ShareRepo does not manage".
6. Check the audit trail. There is no audit page yet, so query the local database: `pnpm --filter @sharerepo/web exec wrangler d1 execute DB --local --command "SELECT action, target_id, occurred_at FROM audit_events WHERE action LIKE 'provider.%' ORDER BY occurred_at"`. Every `provider.mutation_attempted` has a matching `provider.mutation_succeeded`, `provider.mutation_failed` or `provider.mutation_resolved`.

Record the outcome under the manual checklist in `docs/research/github-live-results.md`. If any assumption in decision 0010 turns out wrong, raise it before merging.

## 8. Deployed environments

For dev and production, create one App per environment, with the same settings and that environment's URLs. Set the values as Worker secrets and vars instead of `.dev.vars` (see `docs/deployment.md`). Never reuse the development App's key.
