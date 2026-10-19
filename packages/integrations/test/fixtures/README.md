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
| `user-by-id.json` | `GET /user/{account_id}` ("Get a user using their ID"; the same shape) |
| `collaborators-page-1.json` | `GET /repos/{owner}/{repo}/collaborators?affiliation=direct&per_page=100`, first page (served with `Link: rel="next"`; docs.github.com/en/rest/collaborators/collaborators) |
| `collaborators-page-2.json` | second and last page (of both affiliations): a collaborator with only `pull` and `triage` |
| `collaborators-all-page-1.json` | `…?affiliation=all`, first page: the owner (all permissions) before the direct collaborators |
| `invitations.json` | `GET /repos/{owner}/{repo}/invitations?per_page=100`: an expired invitation, an email invitation (`invitee: null`) and a pending one (docs.github.com/en/rest/collaborators/invitations) |
| `invitation-created.json` | `PUT /repos/{owner}/{repo}/collaborators/{username}` → 201, the pending invitation |
