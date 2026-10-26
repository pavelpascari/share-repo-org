# Plan — manual access and removable customer links

**Status:** Implemented on `feature/manual-access` (from `phase-6/hardening`). Decision: [0016](../decisions/0016-manual-access-source.md). Threats: [purchase-claim threat model](../security/purchase-claim-threat-model.md) § Manual access (M1–M5) and § Supported creator paths.

## Goal

The product owner (2026-10-25) made two previously accepted risks normal creator features:

1. A creator gives an offer's repositories to a GitHub account with no purchase, for early buyers and trials (**manual access**). It is attributable to the owner and removable by hand.
2. A link a creator made through a checkout reference (T12) is legitimate. The owner sees how every link was made and can remove it. The pre-registered-customer risk stays accepted, with removal by hand as its creator-side recovery.

## Scope

- In: a `manual` entitlement source; grant, change the end date and revoke; the end date as a database timer; offer versions; workspace and account deletion; export; access and Customers pages; removing a customer link; limits; audit.
- In (2026-10-26): manual access on the recipient's **My access** page, like a purchase.
- Out: bulk grants; grants for teams or organizations; any Paddle API change.

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

## Decided (2026-10-26)

1. **My access for recipients.** "Yes it should. but it should not look any different than if they went through the purchase." Done: My access lists manual access through the recipient's own GitHub ID, as purchases are, with the same component and wording. An end date shows as a scheduled cancellation; there is no source label and no note (`isolation/cross-workspace-read-denied` in `packages/db/test/customer-links.test.ts`, and the E2E journey).
2. **End date.** "let's pick end of day at the recipients timezone." ShareRepo cannot know the recipient's time zone, so access ends at the end of the chosen date anywhere on Earth: 12:00 UTC the next day ([decision 0017](../decisions/0017-manual-access-end-of-day.md)). The page says "Access ends after <date>". Nothing has shipped, so no stored row needs a migration.
3. **Limits.** 100 open grants and 50 new grants a day per workspace are confirmed for now: "we can adjust later".
4. **Checkout-reference attribution.** "Let's spike it." Prepared: `pnpm spike:paddle-origin` and [the procedure](../research/paddle-reference-origin-spike.md). **Open item:** pending the product owner's sandbox run and results.
5. **Who can grant.** "No. Only owners." As implemented (`workspace.manage`).

## Known edge cases (deferred)

The product owner's rule for now (2026-10-26): build the main path and note the exceptions; they will be examined when ShareRepo opens up as a SaaS. Security and workspace isolation are part of the main path.

- **Impossible calendar dates.** `parseManualAccessEndDate` checks the `YYYY-MM-DD` shape and that it parses. A day past the month's end (`2026-02-30`) rolls over to the next month, as JavaScript dates do. The page's date input sends only real dates.
- **The recipient's view of an end date.** My access shows the stored instant like a purchase's cancellation, so a grant ending after 2026-10-26 reads "Cancels 2026-10-27" (12:00 UTC). The creator's page reads "Access ends after 2026-10-26".
- **Several grants or purchases for one workspace.** My access lists each as its own card, as it does for several subscriptions.
- **A recipient's account renamed on GitHub.** The grant follows the immutable ID; the creator's list shows the login snapshot until the account is next resolved.
- **The rate limit counts refused grants.** A grant refused after the limit was taken (a login that does not resolve) still uses one of the 50 a day.
- **A crash between a grant's writes and a resubmitted form** can count the rate limit twice (`crash/every-batch-boundary-converges`).
- **Reactivating an ended grant** is done by editing its end date. Revoked grants are final; the owner grants again.
- **Grants for organizations, teams or bots** are refused, not supported.
