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
- **Invite:** `PUT …/collaborators/{login}`, sent with no `permission`, after the login is re-resolved from the user ID. A `201` is a pending invitation, never access. A `204` means the person is already a collaborator: GitHub created nothing, so the access is recorded as unmanaged (decision 0010).
- **Revoke:**
  - an active collaborator: `DELETE …/collaborators/{login}`;
  - a pending invitation: `DELETE …/invitations/{id}`.
  
  A `404` means it is already gone. When an invite, removal or cancellation returns `404`, the adapter checks whether the repository is still there. If the repository is gone, a resync runs.
- **Polling, not webhooks.** No event reports invitation acceptance or expiry on a personal installation. Each repository therefore has its own reconciliation schedule.

| Adapter failure | Grant result |
|---|---|
| `transient` (including a request aborted after its 20-second timeout), `malformed_response` | Retryable `provider_unavailable`, backoff of 1, 5, 15, then 60 minutes |
| `rate_limited` | `rate_limited` until `retryAfter`, minimum 1 minute. The run stops. |
| `rejected` 422 on invite | `invitation_rejected`: the owner must act, then press "Retry" |
| `rejected` 403 | `app_permission_missing`: Administration write is not granted |
| `not_found` account | `account_not_found` |
| `not_found` repository | The grant is unchanged, and the connection is resynced |
| `suspended` | The run stops, and the planner blocks with `connection_inactive` |
| `not_found` installation (minting its token) | The run stops as `installation_missing`, and the connection is resynced |

A failed observation leaves the grants alone. The repository records the classified code (`last_reconcile_error`, shown on the access page) and its consecutive failures, and backs off by them with the same 1, 5, 15 and 60 minutes (a rate limit waits at least `retryAfter`). A suspended or missing installation, or a missing repository, queues a resync.

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

### Paddle in v1 (decisions 0011 and 0012)

Paddle is the commercial source. It reports who paid for what; the entitlement engine decides access. The adapter lives in `packages/integrations/src/paddle` behind `PaddlePort`. Tests use `FakePaddle` from `@sharerepo/integrations/testing`, and E2E uses an HTTP fake built on it (`apps/web/e2e/support/fake-paddle.ts`).

### Connection

- **One connection per workspace,** made with an API key the creator creates for ShareRepo. OAuth comes later, as a second credential kind.
- **Connect** runs in this order, and stops at the first failure:
  1. The key must match Paddle's current format. Legacy 50-character keys are refused. Production takes only live keys; every other environment only sandbox keys.
  2. `GET /` must name a seller (`slr_…`) in the same environment and list every required permission: `product.read`, `price.read`, `customer.read`, `subscription.read`, `transaction.read`, `transaction.write` and `notification_setting.write`. A missing permission is named on the page.
  3. ShareRepo creates its notification destination, `<public origin>/webhooks/paddle/<connectionId>`, and keeps the signing secret.
  4. The key and the secret are stored as envelopes bound to the row. If storing fails, the destination is deleted again.
  5. The catalog is imported (`GET /prices?include=product`). A failed import leaves the connection active, and the page asks for "Refresh catalog".
- **Reconnect** replaces the key. The new key must belong to the same seller. A destination deleted outside ShareRepo is created again.
- **Disconnect** deletes the destination (best effort) and erases both envelopes. If Paddle could not be asked, the page shows the `ntfset_…` ID to delete by hand.
- **Status.** A `401` or `403` on any call marks the connection `unauthorized`, audited, and the billing page shows "Needs a new API key". Processing keeps the last known facts; nothing is revoked because Paddle cannot be read. An `api_key.*` event queues a probe (`GET /`), because its payload does not say which key it concerns.

### Port

| Operation | Request | Used for |
|---|---|---|
| `getApiRoot` | `GET /` | Seller, environment and permissions; the health probe |
| `listPrices` | `GET /prices?include=product&status=active,archived&per_page=200` | The catalog |
| `getSubscription` | `GET /subscriptions/{id}` | Every refresh |
| `listSubscriptions` | `GET /subscriptions?per_page=200` | The daily sweep |
| `listCustomerSubscriptions` | `GET /subscriptions?customer_id=&status=<every status>&per_page=200` | The purchase rule of path 1 |
| `listCustomersByEmail` | `GET /customers?email=&per_page=200` | Claiming by email (path 2) |
| `getCustomer` | `GET /customers/{id}` | Customer lookups |
| `createTransaction` | `POST /transactions` with `custom_data.sharerepo_claim` | Starting a checkout (path 1) |
| `createNotificationSetting`, `getNotificationSetting`, `deleteNotificationSetting` | `/notification-settings` | The webhook destination |

Every request sends `Paddle-Version: 1` and has a 20-second timeout. Every response is parsed with Zod. Lists follow `meta.pagination.next` while `has_more`, up to 30 pages. The next-page URL must stay under the API base URL, because the request carries the seller's key. The sweep and the purchase rule accept a list cut short at the cap and say so; other lists fail as `malformed`.

### Errors

| Kind | Cause | Handling |
|---|---|---|
| `unauthorized` | `401` or `403`: the key is invalid, expired, revoked, or lacks a permission | The connection becomes `unauthorized`. The job fails as `PaddleUnavailableError` and is retried; stored facts stand |
| `not_found` | `404` | A subscription Paddle does not know is `found: false`. Deleting a destination that is already gone succeeds |
| `rate_limited` | `429` | Retried after `Retry-After` (seconds or a date; 60 s when absent) |
| `transient` | `5xx`, a network failure, or the timeout | Retried with backoff |
| `rejected` | Any other `4xx`, or input refused before sending | Final. Two codes are acted on: `notification_maximum_active_settings_reached` (the seller has 10 active destinations; connect fails with that reason) and `transaction_default_checkout_url_not_set` (no default payment link; the checkout page names the setup step) |
| `malformed` | A `2xx` body of the wrong shape, or too many pages | Final |

Errors carry the operation, the status and Paddle's `error.code`. They never carry the key, an email, custom data, or Paddle's `detail`, which may echo input.

### Webhooks

- **Route:** `POST /webhooks/paddle/:connectionId`, before React Router.
- **Rules,** in order:
  1. Without the commerce secrets: `503`.
  2. An unknown or disconnected connection: `404`.
  3. A body over 1 MB: `413`.
  4. The signature is checked on the raw bytes: `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 of `ts:body` under the connection's secret. Any `h1` may match. `ts` may be at most 5 minutes ahead and 72 hours old. A failure gets `401` and nothing is stored.
  5. A signed body that is not an event envelope: `400`.
  6. The event ID, type, time and subscription are stored with a `process_external_event` outbox row in one batch, then `200`. A redelivery of the same `evt_` gets `200` and changes nothing.
- **Deduplication** is scoped to the connection: one creator cannot suppress another's events by signing a colliding `evt_` ID.
- **Payloads are never stored or logged.** Processing reads Paddle instead (below).

### Event handling

Do not write logic such as "`transaction.payment_failed` means revoke now". An event is a hint. It makes ShareRepo read the subscription again; policy then recomputes entitlements. A failed renewal produces a past-due state with a grace period, and a cancellation can take effect later.

```text
signed Paddle webhook
  -> verify and deduplicate
  -> persist ExternalEvent + process_external_event (one batch)
  -> subscription.* / transaction.* with a subscription: queue refresh_subscription (deduplicated)
     api_key.*: queue check_paddle_connection
     anything else: ignored
  -> refresh: GET /subscriptions/{id}, normalize, verify the claim reference
  -> persist Subscription, link the customer if the purchase rule allows
  -> recompute Entitlements
  -> queue reconciliation
```

- **Normalizing.** `state` is Paddle's status. `cancelAt` is a scheduled cancellation's `effective_at`; a scheduled pause is ignored until it takes effect. `pastDueSince` keeps the earliest time while the subscription stays past due, so later updates never extend grace. A refresh applies only an `updated_at` newer than the stored one.
- **Linking** follows decision 0012. A verified claim reference links the customer only when every subscription Paddle holds for it carries that reference (the purchase rule). A link queues a refresh of each of the customer's subscriptions.
- **Repair.** The daily cron queues a sweep per active connection. It lists the seller's subscriptions and refreshes any that are unknown or newer than stored.
- **Hand-off.** Processing an event, and making a link, queue a refresh in the outbox. The jobs Worker (after a job) and the web Worker (after a claim or a manual link) hand such refreshes to the queue at once, so a purchase is read within seconds. The outbox drain, every minute, is the safety net. Reconciliation keeps its own schedule (decision 0010), so the invitation follows at the next check.

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

