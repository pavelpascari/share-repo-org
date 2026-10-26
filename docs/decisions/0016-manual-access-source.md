# 0016 — Manual access: an entitlement source without a payment provider

**Status:** Accepted (manual access and the creator link are a product decision, 2026-10-25)

## Context

The [purchase-claim threat model](../security/purchase-claim-threat-model.md) accepted two risks in Phase 5: a customer pre-registered through a checkout, and a creator linking customers through a checkout reference copied in the Paddle dashboard (T12). The product owner decided:

> Both of these should be possible under normal features for sharerepo; the audit logs can be registered under the manual source of the creator making the action - so that is legit; The access can also be removed by hand - so i think relaxing the mandatory link to paddle or other PSP for the manually added ones is OK. And it actually makes the product more appealing for early creators that are maybe trying out the plaform or want to share their product with an early buyer.

Until now every entitlement derived from a subscription (`ENTITLEMENT_SOURCE_TYPES = ["subscription"]`), and `entitlements.source_id` had a foreign key to `subscriptions`. A creator who wanted to give an early buyer access had to sell it through Paddle, or use the simulator, which does not run in production.

## Decision

### Manual access is an entitlement source

- **What it is.** A workspace owner grants an offer's repositories to a GitHub account, with an optional end date (a UTC instant) and an optional note. It is stored in `manual_accesses` (offer, subject, `ends_at`, note, revocation, `version`, `next_evaluation_at`).
- **Entitlements.** `ENTITLEMENT_SOURCE_TYPES` is `["subscription", "manual"]`. A manual access's entitlements have `source_type = 'manual'` and name it as `source_id`. Migration 0012 rebuilds `entitlements` with two generated columns, `subscription_id` and `manual_access_id` (each is `source_id` when `source_type` names its table, else null). Each has its own composite foreign key, so a source of either type must exist in the same workspace. Writers set nothing new: code deployed before the migration keeps working while it runs.
- **Same pipeline.** Entitlements are planned by `planManualEntitlements`, which shares the subscription planner's diff (`diffEntitlements`), and written in one guarded batch with reconcile requests and audit events. Reconciliation does not know or care about the source: desired state is entitlements, observed state is grants.
- **Policy** (`decideManualAccess`, policy version 1): granted with reason `manual` until the end date (open-ended without one); `manual_ended` (state `expired`) once the end date passed; `manual_revoked` (state `revoked`) once revoked. No grace period.
- **The recipient needs no ShareRepo account.** The login is resolved to its immutable GitHub ID through the workspace's GitHub connection (`resolveGitHubAccount`, shared with the manual customer link). The subject is keyed by that ID per workspace, as for every other source. The login is a snapshot.
- **Works in production.** Unlike the simulated source, which stays outside production (decision 0009).
- **Permission.** `workspace.manage` (owners), in an active workspace. The page is `/w/<slug>/manual-access`; changes are same-origin POSTs.

### Owners' actions

- **Grant** (`access.granted_manually`, actor the owner, the note as the event's `reason`).
  - At most one open (not revoked) manual access per offer and account: a partial unique index. A repeated form submission is `already_granted` and writes nothing.
  - An access whose end date passed is granted again by editing its end date, which creates a new entitlement row (decision 0009: a reactivation adds a row).
- **Edit the end date** (`access.updated_manually`). The new date must be in the future, or null for no end.
- **Revoke** (`access.revoked_manually`, cause `owner`). Final. Revoking again writes nothing.
- Every audit event carries the offer, the subject and the account's immutable GitHub ID, never a login, email or token. The entitlement events the change causes carry the owner as actor and the correlation ID of the request.

### The end date is a database timer (decision 0013)

- `manual_accesses.next_evaluation_at` is the end date while access is granted until it. The per-minute cron evaluates up to 100 due manual accesses itself, before draining the outbox, and records `manual_access.evaluated` (system).
  - The work is local (ShareRepo holds the facts), so it does not go through a queue job. That avoids a new outbox kind, whose CHECK change would rebuild `outbox`.
- **No expiry confirmation.** Decision 0013 waits up to 6 hours for a provider to confirm an end, because a lost renewal webhook must not revoke a paying subscriber. A manual access has no provider: its facts are its own row, so the minute sweep that evaluates it is the confirmation. Between the end date and that tick the entitlement is expiry pending, as the planner's general rule says (nothing new granted, nothing revoked), for at most about a minute. An owner who extends the end date in that minute continues the same row.

### Offer changes

- A manual access follows its offer's **current version**, like a subscription: a new version moves its entitlements to it (repositories added are granted, removed ones revoked with `offer_access_removed`), and archiving the offer revokes them (`offer_archived`).
- `recompute_offer`, which every offer version queues, marks the offer's open manual accesses due, so the sweep re-plans them within a minute. The mark bumps their `version`, so a decision read before it is stale.

### Races are settled in the write batch

A decision is authorized and planned from reads. The batch re-checks, in the same D1 transaction, that the offer is still at the version read, the workspace still in the status read and, for an owner's change, that the user is still an owner (a security review finding, 2026-10-25). An owner change is refused once the workspace is not active. A grant racing a deletion request, a demotion or an offer edit therefore writes nothing; concurrent edits and revocations of one access serialize on its `version`; two concurrent grants of the same offer and account meet the unique index.

### Limits

- **At most 100 open manual accesses per workspace**, counted inside the insert (`INSERT … SELECT … WHERE count < 100`).
- **At most 50 new grants a day per workspace**, through the D1 rate-limit table (one atomic statement; checked before GitHub is asked).
- The per-repository GitHub invitation budget (`INVITATION_BUDGET`, 40 a day) applies to manual grants like any other: reconciliation waits when it is used up. The limits bound how many GitHub invitations a workspace can make ShareRepo send to people who did not buy, and the work of re-evaluating a workspace's manual accesses.

### Data lifecycle (decision 0015)

- **Workspace deletion.** The request marks every open manual access due in its batch; the sweep withdraws their entitlements (`workspace_deleted`) and reconciliation revokes. The purge's repair path marks them due again while entitlements remain. Cancelling marks them due, and the sweep grants them again. The purge deletes `manual_accesses` after `entitlements`.
- **Account deletion.** Deleting the account of a GitHub ID that holds a manual access revokes that access (cause `account_deleted`, actor the deleting user) in the same batch that ends its entitlements, so no later evaluation grants it again. This extends the T6 amendment ("deletion clears every subject of the account's GitHub ID") to manual access. The creator can grant it again.
- **Export** (format version 2) lists `manualAccesses` (without logins), and each entitlement's `sourceType`, `subscriptionId` (null for manual) and `manualAccessId`.
- **Retention.** Manual accesses are kept for the life of the workspace, like subscriptions: they explain entitlements and audit events.

### Manual access is not a manual customer link

- A **manual customer link** (decision 0012, path 3) attaches a Paddle customer to a GitHub account. Access still follows the customer's subscriptions, so it ends when the subscription does.
- **Manual access** needs no customer or subscription at all. It ends only by its end date or by hand.

### Checkout references and removable links (risk T12)

- **Whether a creator's link can be told apart.** It cannot, reliably:
  - The subscription entity ShareRepo re-reads names no transaction ([paddle-billing.md](../research/paddle-billing.md) § 4: only `subscription.created` carries `transaction_id`, and webhooks are hints).
  - A reference can reach another subscription in two ways. The seller can edit its custom data (dashboard or API). A buyer can also pass a reference into another checkout through Paddle.js `customData` (threat T11). Only the first is the creator.
  - The checkout claim does store the transaction ShareRepo created, and `GET /transactions/{id}` (`transaction.read`, already required) reports its `subscription_id`. Comparing it would show only that the reference arrived *some other way*, not *who* made it arrive. Whether Paddle sets `subscription_id` before `subscription.created` is delivered is unconfirmed, so a genuine checkout could be misread. Neither the fake nor the recorded fixtures cover that call.
- **So the link is made legitimate and visible instead.**
  - The Customers page shows how each link was made, read from the audit trail: ShareRepo checkout, emailed claim, a manual link, or the simulator.
  - An owner can remove any link, with a reason (`customer.unlinked_manually`). The customer's subscriptions are refreshed, so their entitlements end (`customer_unlinked`).
  - The checkout claim that customer used never links it again: path 1 returns early for a customer that used the claim and was unlinked since. An emailed claim (path 2) or a manual link can link it.
  - A link a creator makes through a checkout reference stays `claim.completed` by the system. The creator's own deliberate path is a manual link (path 3), or manual access.

## Consequences

- New audit actions: `access.granted_manually`, `access.updated_manually`, `access.revoked_manually`, `manual_access.evaluated`, `customer.unlinked_manually`. New decision reasons: `manual`, `manual_ended`, `manual_revoked`. `entitlement.created` names a subscription or a manual access. The export's format version is 2.
- An entitlement may now have no subscription. Code that joined `entitlements.source_id` to `subscriptions` now uses `subscription_id` or filters on `source_type`: the access view (which names the source `manual`), the lapsed-entitlement repair, the offer recompute, and the failure pages.
- The minute tick does a little local work besides queueing. Its heartbeat reports `manualAccessesEvaluated`, and the evaluation backlog includes due manual accesses.
- A recompute's due mark is an unaudited scheduling hint, like the subscription sweep clearing its timer; the evaluation that follows is audited.
- Amends: decision 0009 (entitlement sources), 0013 (a timer without expiry confirmation), 0015 (deletion, export, purge order).
