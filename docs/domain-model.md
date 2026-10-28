# ShareRepo domain model

## Ubiquitous language

Use these terms consistently in code, database schema, documentation, and product discussions.

### User

A person with a ShareRepo account. A user can belong to one or more workspaces and link multiple external identities.

### Workspace

The tenant and primary authorization boundary. It owns connections, resources, offers, commercial records, entitlements, grants, and audit events. A workspace can represent an individual creator or a team.

Its status is `active`, `suspended`, `deleting` or `purging` ([decision 0015](decisions/0015-data-lifecycle.md)). Only an `active` workspace accepts changes, checkout and claims.

- **`deleting`:** the owner asked to delete it. It is read-only, its access is being withdrawn, and `delete_after` (30 days later) says when its data may be purged. The owner can cancel until then, which makes it `active` again.
- **`purging`:** the purge has started. It is reached only from `deleting`, and never left; the workspace row is the last thing deleted.

### Workspace membership

The relationship between a user and a workspace, including role. Initial roles can remain small, for example `owner` and `member`, but authorization should not be inferred solely from being the user who created a connection.

### External identity

A provider identity linked to a ShareRepo user, such as `github:12345`. The durable key is the provider's immutable user ID, not a mutable username or email.

### Connection

A workspace-authorized provider account or installation. Examples are a GitHub App installation or a Paddle seller connection. A connection owns encrypted credential material and provider-specific configuration through its adapter.

### Resource

Something for which an access provider can grant access. In v1, every resource exposed in the product is a GitHub repository. The internal record uses `provider`, `type`, and immutable `externalId` so future access providers do not require GitHub foreign keys throughout the core.

### Subject

The access-provider principal that can receive a grant. In v1 this is normally a GitHub user resolved from a ShareRepo user's linked GitHub identity. Keep the concept capable of representing a provider group or service principal later without implementing those cases now.

### Offer

A creator-defined promise that maps one or more commercial items, initially Paddle prices, to one or more desired resource accesses. Offers are workspace-owned and should retain enough version history to explain existing subscriber access after configuration changes.

### Customer

A commercial identity within an entitlement source, such as a Paddle customer (`ctm_…`). A customer is not automatically a ShareRepo user. It is linked to a subject only through a claim (below). ShareRepo never stores a customer's email.

### Claim

How a customer becomes linked to a subject ([decision 0012](decisions/0012-purchase-claims.md)). There are three paths:

1. **Checkout claim.** A signed-in buyer starts checkout from `/buy/<offerId>`. ShareRepo stores a checkout claim (workspace, user, offer, price; 7 days) and sends a signed **claim reference** to Paddle in the transaction's custom data. The refresh that sees the reference on the subscription links the customer.
2. **Emailed claim.** A buyer who paid through a link the creator shared asks at `/c/<slug>/claim`. A **claim request** keeps the email only as an envelope until a job handles it. The job emails a **claim token** (single use, 24 hours, only its hash stored) to each matching customer ShareRepo knows. Confirming the token links the customer, and moves an existing link.
3. **Manual link.** A workspace owner links a customer to a GitHub login, with a required reason.

Each path is audited. A link queues a refresh of the customer's subscriptions, so entitlements follow it.

An owner can also remove a link, whichever path made it, with a reason (`customer.unlinked_manually`, [decision 0016](decisions/0016-manual-access-source.md)). The Customers page shows how each link was made, read from the audit trail. A checkout claim the customer already used never links it again; paths 2 and 3 can.

### Manual access

An owner's grant of an offer's repositories to a subject, with no customer or subscription ([decision 0016](decisions/0016-manual-access-source.md)). It has an optional end date (a UTC instant), an optional note, and can be revoked. It is an entitlement source of its own: its entitlements have `sourceType` `manual`. Its status is derived: `active`, `ended` (the end date passed; a later end date grants it again) or `revoked` (final).

Not to be confused with a manual customer link (claim path 3): that links a Paddle customer, and access still follows its subscriptions.

### Subscription

The normalized commercial agreement observed from an entitlement source. It records facts such as provider state, billing period, cancellation timing, and customer. It does not itself represent repository access.

### Entitlement

The durable statement that a subject should have a specified access level to a resource for a time interval, with a traceable source and policy decision.

> Entitlement is desired state.

An entitlement may exist while provisioning is pending or failing.

### Grant

The latest known provider-side access state for a subject and resource, including pending invitation, provisioned, absent, revocation pending, or error. It records whether ShareRepo manages the access (`managed`) and whether it is `indirect`; see State sketches § Grant.

> Grant is observed actual state.

A grant must not be treated as proof that the commercial entitlement still exists.

### External event

An immutable receipt of a provider webhook or synchronization fact, identified by the provider's stable event ID where available. Processing status may change; the received identity and payload digest do not.

### Audit event

An append-only explanation of a meaningful ShareRepo decision or action: who or what initiated it, which workspace and objects were involved, what changed, why, and the outcome. Audit events are domain-facing history, not raw application logs.

### Failure

A job that stopped for good and needs a person ([decision 0014](decisions/0014-failure-handling-and-alerting.md)): an outbox row with `failed_at` and a classified error code, recorded with a `job.failed` audit event. It belongs to a workspace, or to none for system-wide work. It is resolved by a **retry** (due again, attempts reset; `job.retried`) or a **dismissal** by an operator, with a required reason (`dismissed_at`, `dismissed_by`, `dismiss_reason`; `job.dismissed`). The row is kept either way until pruning. A repository whose checks fail 3 or more times in a row is shown as a failure too, from its own `reconcile_failures`.

### Operator

A person who runs ShareRepo: a signed-in user whose GitHub account ID is listed in the `OPERATOR_GITHUB_IDS` configuration. It is not a role and is not stored in the database. Code proves it with an `OperatorPrincipal`, which operator services take alongside an explicit workspace. Operator actions are audited with actor type `operator`.

### System state

Unaudited bookkeeping that belongs to no workspace record, in the `system_state` table (`key`, JSON `value`, `updated_at`): the sweep's last heartbeat (`sweep.heartbeat`) and lag alert (`sweep.lag_alerted`), and a purge's progress (`purge_progress:<workspaceId>`) and the reason it waits (`purge_blocked:<workspaceId>`). It never decides access.

## Core distinction

```text
COMMERCIAL STATE                  ACCESS STATE

Customer                          Subject
   |                                 |
Subscription                      Resource
   |                                 |
Offer/policy                        Grant
   |                                 ^
   +----------> Entitlement ---------+
                   desired      reconciliation
```

Example:

```text
Paddle subscription sub_123 is active
    -> policy creates an entitlement
    -> GitHub user 42 should have read access to repository 99
    -> reconciler observes no access
    -> GitHub adapter creates an invitation/grant
    -> Grant records pending or active provider state
```

## Suggested records

These are conceptual fields, not a final migration.

```text
User
  id
  createdAt
  updatedAt

ExternalIdentity
  id
  userId
  provider
  externalUserId
  usernameSnapshot
  displayNameSnapshot
  avatarUrlSnapshot
  verifiedAt

Workspace
  id
  slug
  name
  status
  createdAt

WorkspaceMembership
  workspaceId
  userId
  role

Connection
  id
  workspaceId
  provider
  kind
  externalConnectionId
  status
  credentialEnvelopeId
  capabilitiesSnapshot
  lastSyncedAt

Resource
  id
  workspaceId
  connectionId
  provider
  type
  externalId
  displayName
  locator
  status
  metadataSnapshot

Subject
  id
  workspaceId
  provider
  externalIdentityId
  externalSubjectId
  type

Offer
  id
  workspaceId
  name
  status
  policyVersion

OfferCommercialItem
  offerId
  entitlementSourceConnectionId
  providerItemType
  externalItemId

OfferAccess
  offerId
  resourceId
  accessLevel

Customer
  id
  workspaceId
  connectionId
  externalCustomerId
  linkedUserId

Subscription
  id
  workspaceId
  connectionId
  customerId
  externalSubscriptionId
  normalizedState
  providerState
  currentPeriodStart
  currentPeriodEnd
  cancelAt
  lastObservedAt

ManualAccess     (decision 0016)
  id
  workspaceId
  offerId
  subjectId
  endsAt
  note
  revokedAt
  revokeCause
  nextEvaluationAt

Entitlement
  id
  workspaceId
  subjectId
  resourceId
  accessLevel
  sourceType       (subscription | manual)
  sourceId         (the subscription or the manual access)
  policyVersion
  state
  validFrom
  validUntil
  decisionReason

Grant
  id
  workspaceId
  entitlementId
  connectionId
  subjectId
  resourceId
  accessLevel
  state
  externalGrantId
  observedAt
  lastAttemptAt
  lastErrorCode

ExternalEvent
  id
  workspaceId
  connectionId
  provider
  externalEventId
  eventType
  occurredAt
  receivedAt
  payloadVersion
  payloadDigest
  processingState

AuditEvent
  id
  scope            (workspace | account; decision 0007)
  workspaceId      (null for account-scoped events)
  actorType
  actorId
  action
  targetType
  targetId
  reason
  correlationId
  occurredAt
  details
```

Provider-specific details can live in validated metadata or integration tables when they are not part of the portable domain. Do not turn frequently queried or invariant-bearing fields into opaque JSON.

## Invariants

1. Every tenant-owned record has one unambiguous workspace.
2. Relations between tenant-owned records never cross workspace boundaries.
3. Provider identities use immutable provider IDs; usernames and emails are snapshots.
4. A connection is authorized independently from any user's login identity.
5. An external event is unique by provider and stable provider event ID within the relevant connection scope.
6. An entitlement always explains its source, policy version, validity, subject, resource, and access level. Its source is a subscription or a manual access (`sourceType` `subscription` or `manual`), each checked by its own composite foreign key.
7. A grant never creates an entitlement. Provider state cannot become commercial truth.
8. Access mutations are derived from a reconciliation plan, not directly from webhook event names.
9. Revocation timing follows policy and effective dates, not receipt time alone.
10. Audit history is append-only; corrections are represented by later events. The one exception is a workspace's purge: its audit events are deleted while it is `purging`, and an account-scoped tombstone records the counts (decision 0015).
11. Removal of a user-facing account does not silently destroy records required for access repair or legitimate audit retention.
12. Only supported provider capabilities can be selected for an offer.
13. A subject has at most one open (not revoked) manual access per offer. Its terms (end date, revocation) are changed only by a workspace owner, or revoked by the account holder's account deletion; every change is audited with the actor. The system only re-plans its entitlements.

## State sketches

### Entitlement

```text
active -> expired    (validity ended: grace ran out, cancellation took effect, subscription expired, a manual access's end date passed)
active -> revoked    (the source stopped mapping it: paused, offer access removed or archived, customer unlinked, subscription gone, manual access revoked)
```

Stored states are only `active`, `expired` and `revoked` ([decision 0009](decisions/0009-entitlement-policy-v1.md)):

- An ended entitlement is never reopened; a reactivation creates a new entitlement.
- "Expiring" is an active entitlement with `validUntil` set.
- An active entitlement whose `validUntil` has passed is **expiry pending** ([decision 0013](decisions/0013-database-timers-and-expiry-confirmation.md)). Reconciliation grants nothing new for it and revokes nothing, while the subscription's refresh re-reads the source. If the source still grants the access, a refresh within the window continues the same entitlement; otherwise the refresh ends it as `expired`, and access granted again later gets a new entitlement. Once `EXPIRY_CONFIRMATION_WINDOW_MS` (6 hours) has passed, the access is not desired, even if no refresh has recorded the end. `entitlementValidity(validUntil, now)` returns `desired`, `expiry_pending` or `not_desired`.
- "Pending" and "blocked" are reconciliation planner decisions about a subject and resource, not entitlement states.
- **Withdrawn access** ([decision 0015](decisions/0015-data-lifecycle.md)) ends entitlements as `revoked` whatever the subscription says: `workspace_deleted` while the workspace is being deleted, and `account_deleted` when the subscriber deleted their ShareRepo account.

Validity timestamps and the decision reason carry the rest of the meaning.

### Grant

```text
unknown -> absent -> provisioning -> pending_invitation -> active
                     |                    |              |
                     +------ error <------+--------------+
active -> revoking -> absent
```

`error` must include a normalized error code and retry classification. The reconciler should be able to recover from stale intermediate states.

**Ownership (decision 0010).** A grant is `managed` only when ShareRepo created it.

- The flag is set when ShareRepo records its intent (`provisioning`), before the invitation is sent. It stays set while observation keeps finding the access, and it is cleared when the grant becomes `absent`.
- Access observed without that intent is unmanaged: a collaborator the creator added by hand, or an invitation the creator sent. Unmanaged access is reported and never revoked.
- So is access listed after ShareRepo's own invitation was refused (a failure that is not retryable), after its revoke succeeded, or when GitHub answers an invitation with `204` (already a collaborator): GitHub created nothing for ShareRepo, so the creator granted it.
- Access that is not direct (on a personal repository, the owner's own) is recorded as `indirect`. It is also never changed.

**Recovering intermediate states.** `provisioning` and `revoking` are write-ahead intents, each with a `provider_mutations` row in status `started`. The next observation settles them, so a lost response or a crash never causes a blind retry:

- for `provisioning`, an invitation or collaborator found means the request landed;
- for `revoking`, nothing found means the removal landed; access still listed after a removal that succeeded is the creator's, and unmanaged;
- otherwise the planner acts again.

The observation runs at the start of the next reconciliation of the repository. A 5-minute grace period covers GitHub's list lag.

## Identity linking

Payment email, ShareRepo account, and GitHub identity are different facts:

```text
Paddle customer email
        |
        v
verified claim/link
        |
ShareRepo User
        |
        v
linked GitHub ExternalIdentity
        |
        v
GitHub Subject
```

Do not grant repository access from an unverified email match alone. The simulated source links a customer to a subject because the workspace owner names the GitHub account explicitly (decision 0009). Paddle customers are linked only through the three claim paths ([decision 0012](decisions/0012-purchase-claims.md), [threat model](security/purchase-claim-threat-model.md)).

**The purchase rule (path 1).** A buyer can enter any email at Paddle's checkout, and Paddle then puts the subscription on the existing customer with that email. So a checkout claim links a customer only when every subscription Paddle holds for that customer, in any status, carries the same claim reference:

- A customer ShareRepo recorded before the claim was created is refused at once.
- Otherwise ShareRepo lists the customer's subscriptions for every status. The list must include the subscription that carried the reference and every subscription ShareRepo stores for the customer. An empty list, or one cut short at the page cap, is refused.
- A refusal is audited as `claim.rejected` with `customer_has_other_purchases`. The buyer can still claim by email (path 2).
- Before that, and before any link decision, a claim's first use requires its checkout transaction to belong to the subscription that carried the reference (decision 0016). A reference that reached another subscription, by a seller's edit or a buyer's own Paddle.js checkout, is `claim.rejected` with `not_this_checkout` and uses up nothing. While Paddle has not yet set the transaction's subscription, nothing happens until a later refresh.
- If Paddle cannot be read, nothing is linked or refused, and the refresh is retried.
- Once linked, a customer stays linked: renewals need no new check. Path 1 never moves an existing link (`claim.conflict`); paths 2 and 3 do.

| Decision (`decideCustomerLink`) | Meaning |
|---|---|
| `link` | The customer was unlinked |
| `noop` | Already linked to this subject |
| `relink` | Linked to another subject; paths 2 and 3 move it, and the previous subject's entitlements end |
| `conflict` | Linked to another subject; path 1 leaves it |

## Abstraction boundary

The product calls a v1 resource a repository. Code at the domain seam says `Resource`. Provider adapters may use concrete GitHub concepts internally. Avoid fields such as `entitlement.githubRepositoryId`; use `entitlement.resourceId`. Equally, do not invent generalized asset taxonomies, arbitrary permission expressions, or provider-neutral behavior that no implemented use case requires.

