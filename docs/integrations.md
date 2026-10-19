# ShareRepo integrations

## Integration model

ShareRepo has two primary extension boundaries:

- **Entitlement sources** provide commercial facts from which desired access is calculated. Paddle is first.
- **Access providers** expose resources and subjects, and inspect or mutate actual access. GitHub is first.

Authentication providers may overlap with access providers, but login remains a separate concern from workspace connections.

## Shared adapter rules

Every adapter must:

- validate inbound data at runtime;
- translate provider objects into normalized domain facts;
- retain immutable external IDs and useful correlation IDs;
- support pagination and incremental synchronization where the provider does;
- classify errors as retryable, rate-limited, terminal, or user-action-required;
- expose provider capabilities instead of faking uniform behavior;
- avoid leaking SDK or webhook types into the domain;
- be safe under duplicate calls and concurrent reconciliation;
- provide test fixtures for signed events and API responses;
- document required permissions, credentials, scopes, and rate limits.

## Access provider port

A first interface may look like this; refine it from real GitHub behavior rather than preserving the exact syntax:

```ts
type AccessLevel = "read";

interface ProviderCapabilities {
  resourceTypes: readonly string[];
  accessLevels: readonly AccessLevel[];
  supportsDirectUsers: boolean;
  supportsInvitations: boolean;
  supportsExpiration: boolean;
  supportsGroups: boolean;
}

interface AccessProvider {
  capabilities(connection: Connection): Promise<ProviderCapabilities>;

  discoverResources(connection: Connection): Promise<DiscoveredResource[]>;

  resolveSubject(
    connection: Connection,
    identity: ExternalIdentity,
  ): Promise<ResolvedSubject>;

  inspectGrant(input: GrantTarget): Promise<ObservedGrant>;

  provision(input: ProvisionGrant): Promise<MutationResult>;

  revoke(input: RevokeGrant): Promise<MutationResult>;
}
```

Prefer explicit result types that can represent pending invitations and already-satisfied operations. The application service, not the adapter, owns entitlement policy and retry scheduling.

## Entitlement source port

Paddle should feed normalized commercial facts, not directly create grants:

```ts
interface EntitlementSource {
  verifyAndParseEvent(request: SignedWebhookRequest): Promise<ExternalEventInput>;

  refreshCustomer(
    connection: Connection,
    externalCustomerId: string,
  ): Promise<CustomerSnapshot>;

  refreshSubscription(
    connection: Connection,
    externalSubscriptionId: string,
  ): Promise<SubscriptionSnapshot>;

  discoverCommercialItems(
    connection: Connection,
  ): Promise<CommercialItem[]>;
}
```

The domain maps normalized subscription facts and an offer policy to entitlements.

## GitHub

### Separate flows

ShareRepo uses GitHub in two independent flows:

1. **User authorization/login** identifies a ShareRepo user and links an external identity.
2. **GitHub App installation** authorizes a workspace connection and selected repositories.

Do not attach an installation to whichever user happens to receive a callback without verifying the installation setup state, workspace intent, and caller authorization.

### Initial responsibilities

The GitHub adapter should:

- complete user authorization needed for identity linking;
- process installation created, changed, suspended, unsuspended, and deleted events;
- mint installation tokens from the GitHub App private key;
- discover repositories selected for an installation;
- resolve a linked GitHub user as a subject;
- inspect collaborator or invitation state;
- add the subject with the supported read-level permission;
- revoke direct repository access where ShareRepo owns that grant;
- normalize pending invitations, missing identity, insufficient permission, rate limit, and seat-related failures;
- periodically refresh installation and repository state.

### Permissions and ownership

Request the minimum permissions that current GitHub APIs require. Validate the exact permission set during implementation. Repository administration or membership permissions may be sensitive and must be explained during onboarding.

ShareRepo must not revoke access it does not own without an explicit policy. Persist enough provenance to distinguish a ShareRepo-managed direct grant from pre-existing organization/team access. If effective access remains after revoking a direct grant, show that accurately rather than claiming the user has no access.

### Provisioning in v1 (decision 0010)

On personal repositories, provisioning works through the collaborator and invitation APIs, with the App's installation token.

- **Observe:**
  - `GET …/collaborators?affiliation=direct` and `?affiliation=all`. Someone in the full list but not the direct one has indirect access.
  - `GET …/invitations`.
  
  People are matched by immutable user ID, never by login.
- **Invite:** `PUT …/collaborators/{login}`, sent with no `permission`, after the login is re-resolved from the user ID. A `201` is a pending invitation, never access. A `204` means the person is already a collaborator.
- **Revoke:**
  - an active collaborator: `DELETE …/collaborators/{login}`;
  - a pending invitation: `DELETE …/invitations/{id}`.
  
  A `404` means it is already gone. When an invite, removal or cancellation returns `404`, the adapter checks whether the repository is still there. If the repository is gone, a resync runs.
- **Polling, not webhooks.** No event reports invitation acceptance or expiry on a personal installation. Each repository therefore has its own reconciliation schedule.

| Adapter failure | Grant result |
|---|---|
| `transient`, `malformed_response` | Retryable `provider_unavailable`, backoff of 1, 5, 15, then 60 minutes |
| `rate_limited` | `rate_limited` until `retryAfter`, minimum 1 minute. The run stops. |
| `rejected` 422 on invite | `invitation_rejected`: the owner must act, then press "Retry" |
| `rejected` 403 | `app_permission_missing`: Administration write is not granted |
| `not_found` account | `account_not_found` |
| `not_found` repository | The grant is unchanged, and the connection is resynced |
| `suspended` | The run stops, and the planner blocks with `connection_inactive` |

### GitHub risks to test

- personal private repositories and lack of suitable read-only collaborator access;
- paid organization seats for outside collaborators;
- invitation limits and pending-invitation behavior;
- organization policies that restrict outside collaborators or app installations;
- user rename versus immutable numeric ID;
- repository transfer, rename, archive, deletion, and installation selection changes;
- indirect access through teams or organization membership;
- suspended installations and revoked user authorization;
- secondary rate limits and abuse protection.

These are discovery outputs for private launch, not details to hide behind the adapter.

## Paddle

### Connection path

Prefer a supported Paddle OAuth/app connection for third-party sellers when generally available to the product. If the private launch must use API credentials, treat that as a temporary connection variant with the same domain boundary and encrypted credential handling.

Where Paddle supports it, automate notification destination/webhook registration. Make reconnection, secret rotation, and disconnection explicit operations.

### Initial responsibilities

The Paddle adapter should:

- connect and identify a seller account;
- discover the products and prices needed for offer configuration;
- register or guide webhook destination setup;
- verify webhook signatures using the raw body;
- ingest stable event IDs and occurrence timestamps;
- normalize customers and subscriptions;
- refresh current state when events are missing, duplicated, or out of order;
- preserve effective cancellation and billing-period timestamps;
- surface connection authorization failures and schema-version mismatches.

### Event handling

Do not write logic such as “`transaction.payment_failed` means revoke now.” A webhook updates known commercial facts, then policy recalculates entitlements. Failed recurring payment may produce a past-due state and retries; cancellation may take effect later.

Suggested flow:

```text
signed Paddle webhook
  -> verify and deduplicate
  -> persist ExternalEvent
  -> enqueue subscription refresh
  -> fetch/normalize current state when needed
  -> persist Subscription
  -> evaluate offer and access policy
  -> replace/revise desired Entitlements transactionally
  -> enqueue reconciliation
```

## Idempotency and ordering

Provider integrations must assume:

- the same event can arrive multiple times;
- an older event can arrive after a newer one;
- a queue message can run more than once;
- a provider mutation can succeed while the response is lost;
- ShareRepo can crash between any two steps;
- a human can alter provider state outside ShareRepo.

Use unique event keys, authoritative refreshes, state observations, deterministic job keys, and compare-before-mutate behavior. Never use processing order alone to decide current truth.

## Reconciliation ownership

The application layer owns the reconciliation algorithm. An access adapter supplies capabilities and provider operations. An entitlement adapter supplies commercial facts. Neither adapter may silently mutate the other side of the system.

For each planned provider mutation, record:

- workspace and connection;
- entitlement and expected policy state;
- resource and subject external IDs;
- requested access level;
- idempotency/correlation key;
- attempt and normalized result;
- follow-up observation;
- resulting audit event.

## Future providers

GitLab should be the first likely second access provider, but do not implement it solely to validate the interface. When added, let it declare its own capabilities and provider-specific UX. Possible later entitlement sources or access providers include other billing systems, package registries, documentation, downloads, community roles, and API access. These possibilities justify clean seams, not v1 scope.

## Integration test strategy

For each adapter, maintain:

- contract tests against recorded, redacted fixtures;
- signature verification tests using exact raw bytes;
- pagination and rate-limit tests;
- duplicate and out-of-order event tests;
- mutation tests for already-present, pending, missing, and permission-denied state;
- sandbox smoke tests kept separate from deterministic CI;
- a manual checklist for provider settings and permissions that cannot be automated.

Never require live provider credentials for the ordinary unit and integration test suite.

