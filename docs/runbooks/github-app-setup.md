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

Install the App on the test repository only (step 4, or directly on GitHub for the spike), then:

```sh
SPIKE_REPO=<your-login>/sharerepo-test SPIKE_SUBSCRIBER=<subscriber-login> pnpm spike:github
```

The spike:
- invites the subscriber, observes the result, cancels and removes the invitation;
- writes the observations to `docs/research/github-live-results.md`;
- leaves the repository as it found it.

If it stops halfway, run it again: every step is idempotent.

Then complete the manual checklist at the end of that file:
- accept an invitation as the subscriber, and check whether a `member` webhook arrived (look at the App's **Advanced → Recent deliveries**);
- check whether branch protection is available on the private repository on your plan.

## 7. Deployed environments

For dev and production, create one App per environment, with the same settings and that environment's URLs. Set the values as Worker secrets and vars instead of `.dev.vars` (see `docs/deployment.md`). Never reuse the development App's key.
