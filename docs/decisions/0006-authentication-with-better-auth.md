# 0006 — Authentication: Better Auth tables, GitHub sign-in, and the E2E seam

**Status:** Accepted (Phase 1; verified by the `spike/better-auth` spike and the Phase 1 implementation, 2026-10-18, better-auth 1.7.10)

## Context

Phase 1 adds GitHub sign-in. The architecture lets Better Auth own login mechanics while ShareRepo owns `User`, `ExternalIdentity`, membership and authorization ([architecture § Identity and authorization](../architecture.md#identity-and-authorization)). Two things were open:

- who owns the user schema, a deferred decision in the implementation plan;
- how E2E tests sign in through OAuth without a backdoor ([0001 open item](0001-stack-versions.md#open-items)).

## Decision

### Schema ownership: separate `auth_*` tables

- Better Auth owns four tables: `auth_users`, `auth_sessions`, `auth_accounts` and `auth_verifications`.
  - The Drizzle adapter finds them by their export names (`modelName`).
  - Date columns are `integer({ mode: "timestamp_ms" })`, because D1 cannot bind a `Date`. Storage is the same epoch-millisecond integer as `Instant`.
- `auth_users.id` is a foreign key to `users.id`, with the same value.
  - A `user.create.before` hook creates the `users` row and its audit event in one `db.batch`.
  - IDs come from our `IdGenerator` (`advanced.database.generateId`).
- ShareRepo owns `external_identities`, keyed by `(provider, external_user_id)` and **unique globally**. It is upserted on every sign-in from the GitHub profile fetched during that request. A username change updates `username_snapshot` and never creates a new identity.
- **No real email in Better Auth.** Better Auth requires a unique email and fails without one, so `auth_users.email` holds the synthetic `github-<id>@users.sharerepo.invalid`.
  - This makes Better Auth's built-in email linking equivalent to linking by GitHub ID. That is safe, and it heals a user left half-created by a failed write, because D1 has no transactions and Better Auth writes the user and the account separately.
  - With linking disabled, that user would be locked out. So: `accountLinking: { enabled: true, trustedProviders: [] }`, GitHub is the only provider, and email/password is off.
- **No OAuth tokens stored.** Sign-in requests no scopes. Account hooks strip tokens, and a CHECK constraint on `auth_accounts` rejects them. Repository access in Phase 2 uses GitHub App installation tokens, never a user's token.

Why not let Better Auth own `users` directly: that would put personal data and Better Auth's required columns on the domain table and give it two owners. Keeping them apart keeps `users` minimal and lets the login profile be deleted for privacy without breaking audit or access-repair records (domain invariant 11).

### GitHub through `genericOAuth`, with our own GitHub client

The built-in `socialProviders.github` hardcodes the authorize, token and user URLs and calls the global `fetch`. We use `genericOAuth` instead:

- `providerId: "github"`, so the routes stay `/api/auth/sign-in/social` and `/api/auth/callback/github`;
- PKCE on;
- `getToken` and `getUserInfo` implemented in our code (`createGitHubClient`), with Zod parsing and an injected `fetch`.

Production uses the fixed `github.com` and `api.github.com` endpoints.

The E2E seam is two variables, `GITHUB_OAUTH_BASE_URL` and `GITHUB_API_BASE_URL`:

- env parsing **rejects** them unless `ENVIRONMENT` is `e2e`;
- only the local-only wrangler `e2e` environment sets them;
- a test asserts the production and dev wrangler configs never set them or `ENVIRONMENT=e2e`.

E2E runs a local fake GitHub OAuth server that checks the client secret, `redirect_uri` and PKCE, and the browser follows real redirects. There is no test-only login route.

GitHub sign-in uses a **GitHub OAuth App**, separate from the Phase 2 GitHub App. This keeps a login identity distinct from an installation (architecture principle 7). Revisit if a single GitHub App for both proves simpler in Phase 2.

### Runtime configuration

- **Per request:** one Better Auth instance is built from the validated env. Better Auth's own logs go through `@sharerepo/platform`'s redacting logger.
- **Secrets:** `BETTER_AUTH_SECRET` (at least 32 characters) and `GITHUB_CLIENT_SECRET` are Cloudflare secrets. `GITHUB_CLIENT_ID` and `BETTER_AUTH_URL` are vars.
- **Sessions:** checked against D1 on every request; no cookie cache, so revocation takes effect at once. Cookies use the `__Secure-` prefix on https.
- **Rate limiting:** on in every environment, with `storage: "database"`. The default in-memory store is per isolate on Workers and therefore ineffective.
- **CSRF:** Better Auth protects only its own routes, so our React Router actions check `Origin` and `Sec-Fetch-Site`.
- **Telemetry:** off.

### Added during implementation

- **Only the OAuth callback is routed** (`/api/auth/callback/github`). Sign-in and sign-out are our own same-origin-checked actions calling Better Auth server-side, so its account-linking, profile-update and session-listing endpoints are unreachable.
- **Sign-in starts through Better Auth's handler**, not its server API, so the rate limit applies. Limits are keyed by `cf-connecting-ip`: Cloudflare sets it and overwrites client values. Without a configured header, Better Auth falls back to one shared bucket for everyone.
- **Identity conflicts refuse the session.** If the GitHub account's identity belongs to another ShareRepo user, the session hook logs `identity_conflict` and returns false. Better Auth then redirects to the error URL instead of answering 500.
- **One instant per service call.** Rows and audit events written by one call share a timestamp, so audit order follows write order.

## Consequences

- A user's GitHub email is not available to ShareRepo. Subscriber claims never rely on it ([claim threat model](../security/purchase-claim-threat-model.md)).
- An orphan `users` row, with no auth profile, is possible after a failed write. It holds no personal data, and the next sign-in by that GitHub user creates a new user, so it is harmless. A later cleanup job may remove orphans that have no memberships.
- Upgrading Better Auth needs the Workers-pool callback tests and the E2E sign-in to pass.
