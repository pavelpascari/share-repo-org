# GitHub response fixtures

These follow the response shapes documented at docs.github.com (REST API version 2022-11-28),
trimmed to the fields ShareRepo reads plus a few it ignores. They are **documented shapes, not
recordings**. Replace them with sanitised recordings from the Phase 2 live spike
(`pnpm spike:github`), keeping IDs and logins fictional.

| File | Endpoint |
|---|---|
| `installation.json` | `GET /app/installations/{id}` (personal account, active) |
| `installation-suspended.json` | the same, suspended |
| `repositories-page-1.json` | `GET /installation/repositories?per_page=100`, first page (served with a `Link: rel="next"` header) |
| `repositories-page-2.json` | second and last page |
| `suspended-token.json` | `POST /app/installations/{id}/access_tokens` → 403 for a suspended installation |
| `user.json` | `GET /users/{username}` ("Get a user", a personal account's public profile; docs.github.com/en/rest/users/users) |
