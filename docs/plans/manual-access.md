# Plan — manual access and removable customer links

**Status:** Implemented on `feature/manual-access` (from `phase-6/hardening`). Decision: [0016](../decisions/0016-manual-access-source.md). Threats: [purchase-claim threat model](../security/purchase-claim-threat-model.md) § Manual access (M1–M5) and § Supported creator paths.

## Goal

The product owner (2026-10-25) made two previously accepted risks normal creator features:

1. A creator gives an offer's repositories to a GitHub account with no purchase, for early buyers and trials (**manual access**). It is attributable to the owner and removable by hand.
2. A link a creator made through a checkout reference (T12) is legitimate. The owner sees how every link was made and can remove it. The pre-registered-customer risk stays accepted, with removal by hand as its creator-side recovery.

## Scope

- In: a `manual` entitlement source; grant, change the end date and revoke; the end date as a database timer; offer versions; workspace and account deletion; export; access and Customers pages; removing a customer link; limits; audit.
- Out: showing manual access on the recipient's **My access** page (see open questions); bulk grants; grants for teams or organizations; any Paddle API change.

## Design summary

| Concern | Choice |
|---|---|
| Source record | `manual_accesses` (offer, subject, `ends_at`, note, revocation, `version`, `next_evaluation_at`) |
| Entitlement FK | `entitlements` rebuilt with generated `subscription_id` / `manual_access_id` and one composite FK each (migration **0012**; 0011 is `deleted_users` from the operations risk fixes) |
| Planning | `planManualEntitlements`, sharing `diffEntitlements` with subscriptions |
| Policy | `manual` until `ends_at`; `manual_ended` (expired); `manual_revoked` (revoked) |
| Timer | `next_evaluation_at`, evaluated in the minute tick (not a queue job: no new outbox kind) |
| Expiry confirmation | None needed: ShareRepo holds the facts; at most a minute of "expiry pending" |
| Offer edits | Follow the current version; `recompute_offer` marks the offer's accesses due |
| Races | Version CAS on the access; the batch re-checks offer version, workspace status, owner role |
| Limits | 100 open per workspace (in the insert); 50 new a day per workspace (D1 rate limit) |
| Audit | `access.granted_manually`, `access.updated_manually`, `access.revoked_manually` (owner), `manual_access.evaluated` (system), `customer.unlinked_manually` (owner, reason required) |
| Export | Format version 2: `manualAccesses`; entitlements name `sourceType`, `subscriptionId`, `manualAccessId` |

## Scenarios

| Scenario | What it proves | Tests |
|---|---|---|
| `manual/grant-provisions-without-subscription` | A grant by login stores the immutable ID, creates entitlements, and reconciliation invites | `packages/application/test/manual-access.test.ts` |
| `manual/duplicate-grant-is-noop` | A resubmitted grant, revoke or same end date writes nothing | application |
| `manual/revoke-removes-access` | Revoking ends the entitlement; reconciliation removes the collaborator | application |
| `manual/end-date-expires-via-sweep` | The minute sweep ends access at the end date, once; replay writes nothing | application, `apps/jobs/test/manual-access.test.ts` |
| `manual/follows-current-offer-version` | An offer edit moves entitlements to the new version; archiving revokes | application |
| `manual/workspace-deletion-withdraws-and-restores` | Deletion withdraws; cancelling grants again | application |
| `manual/account-deletion-revokes-manual-access` | The recipient's account deletion revokes the grant for good | application |
| `manual/open-limit-and-rate-limit` | 100 open, 50 a day | application |
| `manual/concurrent-changes-converge` | Grants racing a deletion, a demotion or an offer edit write nothing; revoke vs edit and double grants serialize | `packages/db/test/manual-access.test.ts`, application |
| `manual/owner-grants-and-revokes-by-login` | The page grants, edits and revokes; E2E: invited, accepted, removed | `apps/web/test/manual-access-routes.test.ts`, `apps/web/e2e/manual-access.spec.ts` |
| `claim/owner-unlink-removes-access` | An owner removes a checkout link; the used claim never links the customer again | `packages/application/test/claims.test.ts` |
| `crash/every-batch-boundary-converges` | New cases: a manual grant (3 writes) and a manual expiry | `packages/application/test/crash.test.ts` |
| `isolation/*` | Cross-workspace revoke, edit, grant and reads are refused; composite FKs reject cross-tenant links | db, application, web |

## Tasks (as delivered)

1. **Domain.** Source type, decision reasons, `decideManualAccess`, `planManualEntitlements`, note and end-date parsing, limits, audit actions; `diffEntitlements` extracted from `planEntitlements`. Literal expectations only; mutation score stays 100.
2. **Storage.** Migration 0012 (`manual_accesses`; `entitlements` rebuild with deferred foreign keys, as 0009) and `at-0012.sql` (built on `at-0011.sql`); the upgrade test learns generated columns. `applyManualAccessWrite`, due marks, account deletion, deletion and cancel batches, sweep backlog, export, access view, customer link paths and unlinking.
3. **Services.** Grant, edit, revoke, evaluate, sweep; `resolveGitHubAccount` shared with path 3; offer recompute and purge repair mark due; account deletion revokes; `unlinkCustomerManually`; Customers show `via`; path 1 ignores a used claim of an unlinked customer.
4. **Jobs.** The minute tick evaluates due manual accesses before the drain.
5. **Web.** `/w/<slug>/manual-access`, the nav link, manual reason copy, Customers "Remove the link".
6. **Docs.** Decision 0016, product, domain model, threat model, scenario catalog, this plan.

## Implementation notes

- **Generated columns.** `insertWhere` now skips generated columns, and new rows are typed `StoredRow<T>` (no generated fields); reads return them. drizzle-kit 0.31 lists generated columns in a rebuild's `INSERT … SELECT`, which SQLite rejects; 0012's copy lists stored columns only (hand-edited, snapshot unchanged).
- **The deferred-FK rebuild.** As in 0009, `PRAGMA defer_foreign_keys=on` before the rebuild and `off` after it: switching it off clears the count the DROP's implicit delete recorded for `grants` rows. The upgrade test checks `PRAGMA foreign_key_check`.
- **Why no queue job for the timer.** A new outbox kind changes `outbox_kind_valid`, which rebuilds `outbox`; the work needs no provider, so the tick runs it. A failing evaluation stays due and does not stop the others.
- **Due marks bump the version.** So a decision read before a deletion, cancel or offer change cannot overwrite the mark. The mark itself is an unaudited scheduling hint (like the subscription sweep's), listed as such in the audit-completeness test; the evaluation is audited.
- **Owners write only in active workspaces.** `decide` makes an owner's decision stale when the workspace it read is not active, and the batch re-checks status and role; the grant then re-authorizes, so a deletion or demotion surfaces as 403.
- **Rate limit before GitHub.** A refused request (bad login) still uses one of the 50 a day, which also bounds GitHub lookups.
- **Unlinking.** `applyCustomerLink` accepts a null subject. A checkout claim the customer consumed cannot link it again (its consume guard needs an unconsumed claim); path 1 now returns early instead of asking Paddle on every refresh.
- **Crash convergence.** A crash after the grant's final batch makes the rerun `already_granted` with identical state. The rate-limit counter (global table) may count twice.

## Code and documentation conflicts found

- `docs/domain-model.md` § State sketches used to say an active entitlement past `validUntil` "has already ended… never extends it", which contradicted decision 0013. Resolved by Phase 6 T7, which rewrote the sketch to describe expiry pending; the merged text agrees with the code.
- The threat model listed T12's mitigation as deferred "until Paddle reports the transaction". Paddle does report it on the transaction, but that would not identify the actor; see decision 0016.

## Open questions for the user

1. **My access for recipients.** A recipient who has a ShareRepo account does not see manual access on **My access** (it lists subscriptions). Conservative choice: not shown in v1. Should it be?
2. **End date granularity.** The page takes a date and ends access at 00:00 UTC on it. Should it be the end of that day, or the creator's time zone?
3. **Limits.** 100 open grants and 50 new a day per workspace are defaults. Are they right for early creators?
4. **Checkout-reference attribution.** ShareRepo could compare the checkout's stored transaction with Paddle's `GET /transactions/{id}` to flag links whose reference arrived outside its checkout (not who did it). Worth verifying in the Paddle sandbox before building?
5. **Members.** Only owners can grant. Should members with a future "manager" role be able to?
