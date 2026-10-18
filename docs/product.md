# ShareRepo product brief

## Product statement

ShareRepo is a hosted SaaS at `sharerepo.org` for creators who sell access to private source-code repositories. A creator connects GitHub and Paddle, maps a paid offer to one or more repositories, and ShareRepo keeps subscriber access aligned with payment state.

The product promise is intentionally narrow:

> Connect GitHub. Connect Paddle. Choose which purchase grants access to which private repositories. ShareRepo handles provisioning, revocation, repair, and history.

The internal model leaves room for GitLab and other developer resources later, but the v1 product and language remain repository-centric.

## Strategy

Build a multi-tenant SaaS from the beginning, but launch privately:

1. Use ShareRepo for the founder's own workspace.
2. Invite a small number of creators who already sell code, templates, courses, or boilerplates.
3. Validate GitHub access economics and operational behavior.
4. Add public, self-service onboarding only after the private launch proves the model.

Keep self-hosting technically possible by separating the domain from Cloudflare and provider SDKs. Do not spend initial product effort on installers, deployment documentation, support matrices, or an enterprise distribution.

## Users

### Creator

A person or team selling access. A creator belongs to a ShareRepo workspace, connects provider accounts, chooses repositories, defines offers, and reviews access history and failures.

### Subscriber

A paying customer who links the source-control identity that should receive access. A subscriber may use a different email for payment and must be linked safely to a ShareRepo user and GitHub identity.

### Operator

The person running ShareRepo. During the private launch, the operator needs visibility into event processing, provisioning failures, drift, retries, and manual repair without manipulating database rows.

## Core creator journey

1. Sign in with GitHub.
2. Create or join a workspace.
3. Install the ShareRepo GitHub App on an organization or account and select repositories.
4. Connect a Paddle seller account.
5. Import or select Paddle products and prices.
6. Create an offer that maps one or more prices to read access on one or more repositories.
7. Publish or share the checkout path.
8. Observe subscriber entitlement and repository access status.

GitHub login and GitHub App installation are separate steps. Logging in identifies a person; installing the app authorizes access to repositories for a workspace.

## Core subscriber journey

1. Purchase or subscribe through Paddle.
2. Sign in to ShareRepo and link the required GitHub identity.
3. See which repository access is included and its current status.
4. Receive an invitation or direct grant from GitHub.
5. Retain access while entitlement policy says access should remain active.
6. Receive clear status when identity linking, invitations, payment state, or provisioning needs action.

## Version 1 scope

- Multi-tenant users and workspaces.
- GitHub sign-in and external identity linking.
- GitHub App installation and selected-repository discovery.
- Paddle connection, webhook ingestion, products, prices, customers, and subscriptions needed for access policy.
- Offers mapping Paddle prices to read access for GitHub repositories.
- Explicit subscription, entitlement, and grant records.
- Idempotent provisioning and revocation.
- Configurable or initially fixed grace-period policy for recoverable payment failure.
- Event-driven reconciliation plus scheduled repair.
- Creator-facing access history and actionable failure states.
- Operator visibility and audit events.

## Explicit non-goals for version 1

- A generic marketplace for arbitrary digital assets.
- GitLab, Discord, package registries, documentation sites, downloads, or API keys.
- Write or admin repository access as a product feature.
- A public developer API.
- A polished self-hosted edition.
- Custom enterprise identity providers or SCIM.
- Complex usage billing, metering, taxes, or ShareRepo's own public billing plans.
- A no-code workflow builder.
- Perfect abstraction across every possible provider.

## Product policies to make explicit

Payment events must not directly dictate access changes. Policy converts commercial state into desired access. An initial policy may be:

| Subscription state | Desired access |
|---|---|
| trialing | granted |
| active | granted |
| past due | granted during a grace period |
| paused | revoked |
| canceled | granted until the effective cancellation time, then revoked |
| expired | revoked |

Exact Paddle semantics must be verified during implementation. Policy should be versioned or auditable so an access decision can be explained later.

## Risks requiring early validation

The largest product risk is the GitHub collaborator model, not the technology stack.

- Private repositories owned by personal accounts may not support the read-only collaborator experience ShareRepo needs.
- Outside collaborators on private organization repositories may consume paid GitHub seats.
- Repository invitation limits and pending invitations may constrain creator scale.
- App permissions needed to manage collaborators may feel broad to creators.
- A subscriber can pay before linking a usable GitHub identity.

These constraints can change and must be confirmed against current GitHub terms and APIs before public launch. Phase 1–2 should include a real-world validation spike and record the result.

## Success criteria for private launch

- A creator can complete setup without manually configuring webhooks.
- A valid purchase reaches correct GitHub read access without operator database work.
- Cancellation and failed-payment policy lead to access changes at the intended time.
- Duplicate, missing, and out-of-order events do not create incorrect durable access.
- Manual provider drift is detected and repaired or clearly surfaced.
- Every access decision and provider mutation can be explained from the audit trail.
- The real GitHub seat cost, permission model, and invitation limits are acceptable for the target creator segment.

## Positioning boundary

Publicly, ShareRepo sells access to private repositories. Internally, a repository is a `Resource`, GitHub is an access provider, and Paddle is an entitlement source. This is one deliberate step of generalization: enough to avoid scattering GitHub-specific foreign keys through the system, but not a commitment to build a generic entitlement platform now.

