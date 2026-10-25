# 0015 — Data lifecycle: retention, export, workspace deletion, account deletion

**Status:** Accepted (the four features are a product decision, 2026-10-25; the retention periods are defaults the product owner can change)

## Context

ShareRepo keeps every row forever today. Claim request emails and Paddle credentials are the only exceptions; both are erased when used or disconnected.

Every foreign key to `workspaces` and `users` is `ON DELETE RESTRICT`, so deletion must be an explicit, audited process that revokes access first. `audit_events` is append-only, enforced by triggers. Decision 0007 says privacy deletion "will be a deliberate migration with its own decision". This is that decision.

D1 Time Travel keeps 30 days of point-in-time history, so deleted rows remain restorable by the operator for 30 days after any purge.

## Decision

### Retention (automatic pruning)

A daily `prune_data` job deletes in bounded batches (500 rows per table per run):

| Data | Kept for |
|---|---|
| `external_events`, processed or failed | 30 days after receipt |
| `outbox` rows that were sent | 7 days after sending |
| `outbox` rows that failed and were dismissed | 90 days after dismissal |
| Open failed `outbox` rows | until retried or dismissed |
| `claim_tokens`, `claim_requests`, `checkout_claims` that expired or were used | 30 days after expiry or use |
| `claim_rate_limits` counters | once their window ended |
| `provider_mutations` that settled | 90 days (the invitation budget reads 24 hours) |
| Better Auth sessions and verifications that expired | 7 days after expiry |
| `audit_events` | the life of the workspace or account |

- A row that something still references is never pruned. For example, a `checkout_claim` that linked a customer is kept while that link exists.
- Pruning writes one `data.pruned` audit event per run, with counts per table. It is a system event in account scope.

### Workspace export

- An owner downloads their workspace as one JSON file from the workspace settings page.
- **It contains:** the workspace, members, connections without credentials, repositories, offers, Paddle prices, customers and their links, subscriptions, entitlements, grants, and the workspace's audit events.
- **It never contains** credentials, envelopes, token hashes, claim references or emails.
- It is built on request and streamed. It is rate limited to 5 an hour per workspace, and audited as `workspace.exported`.

### Workspace deletion

1. **Request.** An owner confirms by typing the workspace slug. The workspace becomes `deleting`, with `delete_after = now + 30 days`. The audit event is `workspace.deletion_requested`. While `deleting`:
   - the workspace is read-only, and checkout and claims are refused;
   - every entitlement is ended with reason `workspace_deleted`, so reconciliation revokes the access ShareRepo granted;
   - the Paddle destination is deleted and the stored credentials are erased (as for a disconnect).
   - An owner can cancel within the 30 days, which makes it `active` again (`workspace.deletion_cancelled`). The entitlements are recomputed. Paddle must be reconnected.
2. **Purge.** After `delete_after`, and once no managed grant is still active or pending, a `purge_workspace` job deletes every workspace-owned row in bounded batches. That includes `audit_events`. It finally writes an account-scoped tombstone audit event, `workspace.purged`, with only the workspace ID and the counts.
   - If managed access still exists at `delete_after`, the purge waits and the failure pages show why. Deleting the workspace's data never leaves a collaborator ShareRepo can no longer manage.
   - The GitHub App installation is not removed by ShareRepo. The page tells the owner to uninstall it.
- **The audit append-only trigger** gains one exception: a DELETE is allowed when the row's workspace has status `purging`. The purge job sets `purging` in the same batch as its first delete. No other path can delete audit rows.

### Account deletion

- A signed-in user deletes their account from their profile page, confirming with their GitHub login.
- **It is refused** while they own a workspace that is not `deleting`, because ShareRepo has no ownership transfer. The page lists those workspaces.
- **It runs immediately:**
  - every subject linked to the user's GitHub identity is unlinked from the user, and the subject's entitlements end with reason `account_deleted`, so reconciliation revokes the access ShareRepo granted;
  - their unused checkout claims, claim requests and claim tokens are deleted;
  - their memberships, sessions, accounts, identities, `auth_users` and `users` rows are deleted.
- **Kept:** subjects stay, as workspace records of a GitHub account (immutable ID and last login), because the creator needs them to revoke and explain access. Audit rows that name the user keep only its ID, which no longer resolves to a person.
- It is audited as `user.deleted` (account scope, actor `user`), with counts, never the login.
- A later sign-in with the same GitHub account creates a new user. Old links do not come back; the buyer claims again.

## Consequences

- Decision 0007's append-only rule has one exception, tied to the `purging` status. A test proves the trigger rejects every other delete.
- The 30-day deletion window matches Time Travel. The operator can restore a purged workspace only by an in-place restore, which the runbook treats as an incident procedure.
- New audit actions: `data.pruned`, `workspace.exported`, `workspace.deletion_requested`, `workspace.deletion_cancelled`, `workspace.purged`, `user.deleted`.
- New entitlement end reasons: `workspace_deleted`, `account_deleted`.
- Privacy and legal text describing these periods belongs to Phase 8, and must match this record.

## Amendment — the other append-only tables and the way into `purging` (Phase 6 T1)

Migration 0009 found two more tables a purge must empty, and one weakness in the audit exception:

- **`offer_versions`** is append-only too (decision 0009). Its delete trigger gets the same `purging` exception as `audit_events`.
- **`provider_mutations`** is append-only too (decision 0010), and this record prunes settled rows after 90 days. Its delete trigger now allows deleting a settled row, and a `started` row only while its workspace is `purging`. A `started` row records a request whose outcome is unknown, so pruning never removes one.
- **`purging` is one-way.** The exception is only as strong as the way into `purging`. Triggers allow it only from `deleting`, never allow leaving it, and refuse creating a workspace already `deleting` or `purging`. A CHECK requires `delete_after` and the requester exactly while a workspace is `deleting` or `purging`.

UPDATE stays rejected on all three tables. Threats O10 and O13 in the [operations threat model](../security/operations-threat-model.md) depend on these triggers.

## Amendment — account deletion details (Phase 6 T4)

- **Customers are unlinked too.** Unlinking a subject from the user also unlinks the customers linked to that subject (`customer.linked` to none). This is what makes "old links do not come back" hold: a later sign-in could otherwise link the same subject again. It also keeps a refresh that read the old link from granting access again.
- **The `users` row can outlive the account.** `connections.created_by_user_id` and `offer_versions.created_by_user_id` restrict deletes. While a connection or offer version names the user, for example in their own workspace that is still `deleting`, the account deletion keeps the `users` row. That row holds only an ID and timestamps. Everything else is deleted, including the profile, identities and sessions. Pruning removes the row once nothing names it, after a day.
