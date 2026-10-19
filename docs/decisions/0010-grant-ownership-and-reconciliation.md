# 0010 — Grant ownership and per-repository reconciliation

**Status:** Accepted (ownership policy is a product decision, 2026-10-19)

## Context

Phase 4 makes GitHub access converge to entitlements. Two things must be settled first.

- **Ownership.** `integrations.md` § Permissions and ownership forbids revoking access ShareRepo does not own without an explicit policy. The implementation plan defers that policy to Phases 2–4.
- **Unknowns.** GitHub sends no event when an invitation is created, accepted, declined or expires on a personal-account installation ([research § 7](../research/github-personal-accounts.md#7-webhook-events)). Several provider behaviours are unconfirmed until the live spike runs ([github-live-results.md](../research/github-live-results.md)).

## Decision

### Ownership: ShareRepo manages only access it created

- A grant is **managed** only when ShareRepo created it. ShareRepo records its intent (`provisioning`) before it sends an invitation. Only an invitation or collaborator that this intent could have produced, observed while the intent is outstanding, becomes managed (see the windows below).
- **Access that already exists is left unmanaged.** If the subscriber is already a collaborator, ShareRepo records an unmanaged active grant and sends nothing. When the entitlement ends, ShareRepo does not remove them. The access page shows "Has access ShareRepo does not manage", so the creator can decide.
  - The same holds when the subscriber becomes a collaborator between the observation and the invitation: GitHub answers the `PUT` with `204` and creates nothing, so the grant is recorded `active` and unmanaged, and the mutation `succeeded`.
- **Only what ShareRepo's own request may have created is adopted.** Only the invite write-ahead sets `managed`; observation never turns an unmanaged grant into a managed one. It keeps `managed` only for listed access that ShareRepo's request could have made:
  - **The invite may have taken effect.** It is outstanding, settled by an observation, succeeded, or failed with a retryable error (an outage or a lost response). A refusal (any other retry class) created nothing. Neither did a failure that stopped the run (`suspended`, `installation_missing`, `repository_not_found`): that request never reached the repository, even though its failed row is stored `retryable` because the table needs a class.
  - **An invitation must fall in the invite's window.** Its `created_at` must be within `[started_at − 60 s, started_at + 5 min]` of the invite's write-ahead. The 60 s (`CLOCK_SKEW_MS`) allows for GitHub's clock; the 5 minutes is the observation grace (`OBSERVATION_GRACE_MS`). Anything sent earlier or later was sent by hand and is unmanaged. This holds for a `provisioning` grant, for an `error` after the invite, and for a pending grant that has not recorded its invitation ID. An older invitation listed for a `provisioning` grant still settles the intent, as unmanaged.
  - **A collaborator carries no time.** On a `provisioning` grant, or after a retryable invite failure, a listed collaborator may be ShareRepo's accepted invitation, so it is adopted. This ambiguity cannot be removed: a creator who adds the subscriber by hand while ShareRepo's invitation is outstanding cannot be told apart from an acceptance. After a failure, the ambiguity ends once an observation past the window has found nothing. The invite did not land, and nothing listed later is adopted from it. The grant stays `error` and `managed`, so the retry and, after churn, the settling revoke both still work.
  - **After a revoke succeeds,** anything listed again (past the 5-minute grace for list lag) was granted back by hand, and is unmanaged. A `revoking` grant whose latest mutation is an invite is treated the same way. That combination only arises when a lapsed invitation's cancel succeeded and the reissue then stopped the run, which restored the grant to `revoking`.
  - **While a revoke's outcome is unknown** (outstanding, or failed retryably), a listed collaborator and the grant's recorded invitation stay managed, and the planner revokes again. Any other invitation stays managed only if it was created before the revoke started. After a revoke GitHub refused, only the recorded invitation stays managed.
- **ShareRepo never revokes blind.** A grant whose invitation ID is unknown can only be revoked by removing a collaborator, and that does not cancel an invitation. So ShareRepo does not revoke a grant whose invite may still appear in the lists:
  - a `provisioning` grant is planned `verify` (`intermediate_state`), never `revoke`;
  - an `error` grant whose invite may have taken effect is not revoked until the invite's window closes.
  
  Observation settles the grant first. If ShareRepo's invitation shows up, it is adopted and then cancelled.
- **A managed grant that disappears is no longer managed.** If ShareRepo's collaborator or invitation is removed by hand, the grant becomes `absent` and `managed` is cleared:
  - while the entitlement is live, ShareRepo invites again, and that new invitation is managed;
  - if the creator later adds the person back by hand, that access is unmanaged.
- **Indirect access is reported, never touched.** Access that appears in GitHub's full collaborator list but not its direct list (on a personal repository, only the owner) is recorded as unmanaged and indirect. It is never treated as ShareRepo's.

### Reconciliation runs per repository

- One job reconciles one repository. It:
  1. takes a lease on the repository;
  2. observes the direct and full collaborator lists and the pending invitations;
  3. records grants for the workspace's subjects only;
  4. plans;
  5. performs at most a bounded number of mutations, each recorded before it is sent;
  6. observes again and records the result.
- **Compare before mutate.** No mutation is sent without an observation in the same run that shows it is still needed. A lost response is therefore resolved by the next observation, never by retrying blindly.
- **Polling is mandatory** (decision 0008). Each repository has a `next_reconcile_at`. It is soon while anything is pending, provisioning, revoking or waiting to retry, and every 6 hours otherwise. The per-minute cron sweeps due repositories, so the scheduled sweep is the full repair path.
- **ShareRepo budgets invitations per repository**: at most 40 in any 24 hours, below GitHub's 50 so the creator's own invitations still fit. When the budget is spent, provisioning waits for the window to open, and the access page says so.

### Assumptions until the live spike confirms them

Each assumption is the safe choice. If the spike disproves one, a later change can remove work but never add a risk.

| Unknown | Assumption |
|---|---|
| Does `DELETE /collaborators/{user}` cancel a pending invitation? | No. A pending invitation is cancelled with `DELETE /invitations/{id}`. |
| Are expired invitations still listed? | Either way. A listed invitation with `expired: true`, or one past `created_at` + 7 days, is lapsed, and a missing one is absent. A lapsed managed invitation is cancelled before it is reissued. |
| Is a pending invitee listed as a collaborator? | No. Only the collaborator list makes a grant `active`. |
| Is `permission` ignored on personal repositories? | ShareRepo omits it. The observed permission sets the grant's access level. |
| Do `member` webhooks reach personal installations? | No. Nothing depends on them. |

## Consequences

- No subscriber is ever removed because of access the creator granted by hand. The cost is that a creator who invited a subscriber manually must remove them manually after churn, and the access page shows them.
- The subscriber's GitHub numeric ID is the identity. The login is re-resolved before every invitation, so a rename never invites the wrong account.
- Reconciliation adds two to three GitHub API calls per repository per run, and more when invitations are pending. At private-beta scale this is far below the installation rate limit.
- Organization repositories (a true Read role and team access) need new capabilities and more indirect-access cases. The ownership rules above carry over unchanged.
