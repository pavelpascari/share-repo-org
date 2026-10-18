# GitHub personal-account repositories as a ShareRepo resource

Research date: 2026-10-18. Primary sources only (docs.github.com, github.blog/changelog). Items not confirmed by a primary source are marked **UNVERIFIED**.

## 1. Collaborator permission level on personal-account repositories

- A personal-account repository has only two permission levels: **owner** and **collaborator**. Collaborators "pull (read) the contents of the repository and push (write) changes."
- **Read-only access is not possible.** The docs say that in a private repository, owners can only grant write access to collaborators.
- Collaborators can do the following (from GitHub's list):
  - push, including creating branches and renaming non-default branches
  - create, merge and close pull requests, enable auto-merge, and submit reviews that affect mergeability
  - fork the repository and open PRs from the fork
  - create and edit releases and the wiki
  - manage issues, labels and milestones
  - act as a code owner
  - publish, view and install packages
- **Settings:** collaborators are not listed as able to change repository settings. Settings, deletion and transfer stay with the owner.
- **Secrets:** for personal-account repositories, *collaborators can create repository Actions secrets*. Environment secrets are owner-only. GitHub also states: "Any user with write access to your repository has read access to all secrets configured in your repository" (through workflows). In effect, a subscriber can read any Actions secret in the repo.
- **Recent changes:** I found no 2025–2026 changelog entry that adds a read-only collaborator role to personal repositories. On 2026-02-13 GitHub added repository settings that can limit PR creation to collaborators. That entry says it applies to "all public and private repositories". It controls who can open PRs and does not reduce what collaborators can do. A newer change I missed cannot be ruled out: **UNVERIFIED (absence of change)**.

Sources:
- https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
- https://docs.github.com/en/actions/reference/security/secure-use
- https://github.blog/changelog/2026-02-13-new-repository-settings-for-configuring-pull-request-access/

## 2. GitHub App adding and removing collaborators on a user-owned repository

- **Required permission:** repository permission **Administration: write** for:
  - `PUT /repos/{owner}/{repo}/collaborators/{username}`
  - `DELETE /repos/{owner}/{repo}/collaborators/{username}`
  - `PATCH /repos/{owner}/{repo}/invitations/{invitation_id}`
  - `DELETE /repos/{owner}/{repo}/invitations/{invitation_id}`

  `GET /repos/{owner}/{repo}/invitations` needs Administration: read. All of these accept both user access tokens (UAT) and installation access tokens (IAT).
- `GET /repos/{owner}/{repo}/collaborators`, `.../collaborators/{username}` and `.../collaborators/{username}/permission` need only **Metadata: read** (UAT and IAT).
- All five collaborator and invitation endpoints appear in GitHub's list of endpoints available to installation access tokens. Repository permissions apply to repositories "owned by the account where the app is installed", which includes personal accounts. An App installed on a personal account can therefore manage collaborators with an installation token.
- **`permission` parameter:** documented as defaulting to `push` and "Only valid on organization-owned repositories." The docs do not say whether a value sent for a personal repo is ignored or rejected. **UNVERIFIED:** we expect it to be ignored, with the user getting collaborator (write) access. This needs an integration test against a real personal repo.
- **PUT responses:** `201` means a new invitation was created and the invitee must accept it. `204` means the user was already a collaborator, or an existing permission was changed. `422` covers validation errors and spam flags. Treat `201` as "pending", not "granted".
- **DELETE side effects:** removal also:
  - unassigns the user from issues and unstars the repo
  - deletes forks the user owns of the repo
  - cancels invitations *sent by* that user (not invitations sent *to* them)

  Some of these updates "might take some extra time to complete in the background".
- **Pending invitations:**
  - List: `GET /repos/{owner}/{repo}/invitations` (paginated, max 100 per page; response includes an `expired` boolean).
  - Cancel: `DELETE /repos/{owner}/{repo}/invitations/{invitation_id}`.
  - Change: `PATCH` with `permissions` (read/triage/write/maintain/admin). On personal repos, only write is meaningful, which is **UNVERIFIED**.
  - **Revoking a subscriber who has not accepted must use the invitation DELETE.** Collaborator DELETE does not cover pending invitations to that user. Whether collaborator DELETE on a non-collaborator with a pending invite also cancels that invite is **UNVERIFIED**.

Sources:
- https://docs.github.com/en/rest/collaborators/collaborators
- https://docs.github.com/en/rest/collaborators/invitations
- https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app

## 3. Cost and collaborator limits

- GitHub Free for personal accounts includes **unlimited collaborators on private repositories** ("limited feature set" refers to features, not collaborator count). Pro builds on Free. Personal plans have no per-seat billing, so collaborators cost the creator nothing.
- No collaborator count limit is documented for personal private repositories. **UNVERIFIED** whether an undocumented abuse or spam ceiling exists. The only documented limit is the invitation rate limit (see 4).

Source: https://docs.github.com/en/get-started/learning-about-github/githubs-plans

## 4. Invitation limits, expiry and unaccepted invitations

- **Rate limit:** "limited to 50 invitations per repository per 24 hours" (inviting org members to org repos is exempt). The personal-repo permission page also says GitHub limits how many people can be invited in 24 hours.
- **Expiry:** invitations "will expire seven days after they are created" (changelog, 2020-02-05). GitHub's current per-user pricing page repeats the seven-day expiry for org invitations. The current personal-repo docs do not restate it, but no source supersedes it.
- **Unaccepted invitations:** the user has no access until they accept. The `member` webhook `added` action fires on acceptance, not when the invite is sent. After expiry the invite shows `expired: true` (field documented; exact listing behaviour after expiry is **UNVERIFIED**). A new PUT is needed to re-invite, and it counts against the 50/24h limit.
- Invitees may also be **422-rejected** if GitHub flags spam. Invites can be blocked if the invitee has blocked the owner or vice versa, which is **UNVERIFIED** because no primary source was found.

Sources:
- https://docs.github.com/en/rest/collaborators/collaborators
- https://github.blog/changelog/2020-02-05-self-expiring-repository-and-organization-invitations/
- https://docs.github.com/en/billing/reference/github-license-users

## 5. Forking and what happens on removal

- Collaborators **can fork** a private personal repository. No documented setting lets a personal-account owner disable forking of a private repo. That setting exists only at organization level, which is **UNVERIFIED** for personal repos.
- **On removal:** "If the repository is private and the person has created a fork, then that fork is also deleted." The REST DELETE docs confirm that forks owned by the user are deleted.
- **Local clones survive.** Removal cannot revoke code already downloaded, so access is effectively "updates stop", not "code is taken back".

Sources:
- https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository
- https://docs.github.com/en/rest/collaborators/collaborators
- https://docs.github.com/en/organizations/managing-organization-settings/managing-the-forking-policy-for-your-organization

## 6. Organization-owned repositories (upgrade path)

- **Roles:** Read, Triage, Write, Maintain, Admin, plus custom roles on higher plans. The **Read** role can:
  - pull and fork
  - open PRs from forks, issues and comments
  - **not push or merge**

  The REST `permission` parameter (`pull`, `triage`, `push`, `maintain`, `admin`) is honoured on org repos. A base role set by the org acts as a floor ("Cannot assign {member} permission of {role name}").
- **Forking policy:** org owners can allow or prevent forking of private repos. New organizations disallow it by default. Repo-level fork settings apply only if the org allows forking.
- **Seat cost:**
  - **GitHub Team:** outside collaborators on private repositories, *excluding forks*, consume a paid seat. Pending outside-collaborator invitations to private repos are also billed. Each person is counted once across the org. Inviting by email temporarily uses a seat.
  - **GitHub Free organizations:** unlimited collaborators on private repos with a limited feature set. The license page has no Free-org section; seat implications are **UNVERIFIED** but are believed to be none.
  - Removing users mid-cycle doesn't reduce the current bill.
- **Webhooks:** org installations can request the "Members" organization permission, which unlocks `member` and `organization` events for the App.

Sources:
- https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
- https://docs.github.com/en/organizations/managing-organization-settings/managing-the-forking-policy-for-your-organization
- https://docs.github.com/en/billing/reference/github-license-users
- https://docs.github.com/en/billing/concepts/billing-cycles

## 7. Webhook events

| Event | Actions | App permission | Notes |
|---|---|---|---|
| `member` | added (invite **accepted**), edited, removed | **"Members" organization permission (read)** | **UNVERIFIED** whether an App installed on a *personal* account receives it. Organization permissions apply to org installations, so personal installs may get no `member` events. Do not rely on it; reconcile by polling. |
| `repository` | archived, created, deleted, edited, privatized, publicized, renamed, transferred, unarchived | Metadata (read) | Important for detecting renames, transfers (for example personal account to org), deletion, and visibility changes. |
| `installation` | created, deleted, new_permissions_accepted, suspend, unsuspend | none (always delivered) | Lifecycle of the creator's connection. |
| `installation_repositories` | added, removed | none (always delivered) | Repo selection changes. |
| `repository_invitation` | — | — | Not listed as a webhook event. No event fires when an invitation is created, expires or is declined. |

Source: https://docs.github.com/en/webhooks/webhook-events-and-payloads

## Product implications

> **Decided:** v1 targets personal-account repositories with write access ([0008](../decisions/0008-v1-personal-account-repositories.md)). Live results from the Phase 2 spike go in `github-live-results.md`.

1. **Every subscriber gets write access, and that cannot be changed on a personal repo.** Subscribers can push, delete or force-push non-protected branches, merge PRs, publish releases and packages, and read all Actions secrets through workflows. Creators must be told plainly during onboarding. Recommend that creators:
   - keep no Actions secrets in sold repos
   - protect the default branch with rulesets or branch protection
   - treat the sold repo as a distribution mirror, not the development repo

   Verify that protection is available for private repos on the creator's plan (**UNVERIFIED**; it may need Pro). Model this as a provider capability, for example `supportsReadOnlyGrant = false` for personal GitHub resources.
2. **Grant state machine:** `PUT` returns 201, which should become `Grant = pending_invitation`. A grant becomes `active` only when the collaborators list (Metadata read) shows the user. Because a personal-account App may get no `member` events and no invitation webhook exists, **polling and scheduled reconciliation are mandatory**. Use `GET /collaborators` plus `GET /invitations`.
3. **Revocation must cover both states:**
   - DELETE the collaborator if they are active.
   - DELETE the invitation if it is pending.

   Both are idempotent targets for reconciliation. Expect background lag after removal.
4. **Seven-day invite expiry:** detect `expired` invitations and re-issue them while the entitlement is still active. Tell the subscriber to accept within 7 days. Surface the "accept your invitation" step in the UI.
5. **50 invitations per repo per 24h:** launches or promos can exceed this. The provisioning queue needs per-repository rate accounting, deferral to the next window, and visible "queued" state. Do not retry 50/24h failures quickly.
6. **No leak-back:** removal deletes forks but not clones. Product copy must say that ending a subscription stops future updates and does not recall code already downloaded.
7. **App permissions to request:**
   - Administration: **write**. This is a broad, scary permission for creators, so explain why during install.
   - Metadata: read.
   - Optionally Members (org), for org installations later.

   Installation tokens work for all needed endpoints on personal accounts.
8. **Cost advantage:** personal repos have no seat cost. Org repos on GitHub Team charge a seat per outside collaborator, including pending invites. This makes the org route expensive for creators with many subscribers, even though it gives the Read role and fork control. The upgrade path should be org on GitHub Free with the Read role, if org-Free outside collaborators are indeed unbilled (**UNVERIFIED; confirm before recommending**).
9. **Watch `repository` events** (renamed, transferred, privatized or publicized, deleted) and `installation_repositories.removed`. These should mark the Resource unhealthy and trigger reconciliation, not mutate grants directly.
10. **Integration tests to add against a real personal repo:**
    - behaviour of the `permission` parameter
    - collaborator DELETE on a user with only a pending invite
    - listing behaviour for expired invites
    - whether `member` webhooks reach a personal-account installation
