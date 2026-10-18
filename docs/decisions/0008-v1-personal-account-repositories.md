# 0008 — v1 supports personal-account repositories only, with write access

**Status:** Accepted (product decision, 2026-10-18)

## Context

On a repository owned by a personal GitHub account, a collaborator always gets write access. Read-only collaborators don't exist there ([research § 1](../research/github-personal-accounts.md#1-collaborator-permission-level-on-personal-account-repositories)). A subscriber can therefore push, merge, publish releases and packages, and read Actions secrets through workflows.

Organization repositories support a true Read role. On GitHub Team, though, every outside collaborator (pending invitations included) costs the creator a paid seat. The implementation plan asks for a go/no-go or target-segment decision before Phase 4.

## Decision

- **v1 sells access to private repositories owned by a personal GitHub account.** The first creator, who is also the operator, uses one.
- **Subscribers receive collaborator (write) access.** ShareRepo says so plainly:
  - during connection setup, the creator must acknowledge it; the acknowledgement is stored and audited;
  - in the product copy for subscribers.
- **Recommended creator practice** (shown in onboarding, not enforced):
  - the sold repository is a distribution mirror, not the development repository;
  - it holds no Actions secrets;
  - its default branch is protected.
- **The capability stays explicit.** Each resource records a capability snapshot, with `readOnlyGrant: false` for personal repositories, as architecture principle 9 requires. Organization support later is a new capability value plus adapter work, not a domain change.
- **Organization installations are refused** at setup with a clear message. Their webhooks are stored and processed as no-ops.
- **Only private repositories can be sold.** Public repositories may be listed but are marked not sellable.

## Consequences

- No seat cost for creators. Invitation limits (50 per repository per 24 hours) and 7-day invitation expiry still apply and shape Phase 4.
- Because nothing reports invitation changes for personal installations, Grants must be confirmed by polling the collaborator and invitation lists. Scheduled reconciliation is mandatory, not optional.
- Revocation stops future access. It does not recall clones, and removing a collaborator deletes their forks. Product copy must say so.
- Revisit when a creator needs organization repositories. Start by verifying outside-collaborator billing on GitHub Free organizations.
