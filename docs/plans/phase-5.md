# Phase 5 plan — Paddle integration and purchase claims

Source: `implementation-plan.md` § Phase 5. Decisions:
- [0011](../decisions/0011-paddle-connection-and-tenant-credentials.md): API-key connection, automatic webhook destination, envelope encryption.
- [0012](../decisions/0012-purchase-claims.md): the three claim paths.
- [0009](../decisions/0009-entitlement-policy-v1.md): the entitlement policy. It is unchanged.
- [0010](../decisions/0010-grant-ownership-and-reconciliation.md): provisioning. It is unchanged.

Research: [paddle-billing.md](../research/paddle-billing.md). Threat model: [purchase-claim-threat-model.md](../security/purchase-claim-threat-model.md).

## Goal

Replace the simulated commercial source with Paddle, keeping the entitlement engine as it is. Against Paddle's sandbox, or the fake in tests:

1. A workspace owner connects Paddle with an API key. ShareRepo identifies the seller, checks the key's permissions, registers its webhook destination, and imports the catalog of products and prices.
2. The owner creates an offer from Paddle prices and shares its checkout page, `/buy/<offerId>`.
3. A buyer signs in, starts checkout, and pays. The signed webhook leads ShareRepo to read the subscription. It links the customer through the claim reference and grants the mapped repository access.
4. Someone who paid through a link the creator shared claims later with an emailed one-time link. The owner can also link a customer by hand, with a reason.
5. Past-due, cancellation, renewal and pause from Paddle drive the existing policy, including the grace period and effective cancellation.
6. A revoked or expired key, or a missing destination, is visible, and processing keeps the last known facts. Secrets never leak.
7. A subscriber sees their own access on a "My access" page.

## Out of scope

- OAuth connections. The connection row is ready for them (decision 0011).
- Rotating the webhook secret, central rate limiting for Paddle, and Workflows for timers (Phase 6).
- Checkout hosted on `sharerepo.org`, one-time (non-recurring) purchases, quantities above 1, and seats.
- Storing customer emails or names.
- The simulated source stays available outside production, unchanged.

## Design summary

### Connection lifecycle (decision 0011)

```text
            connect: key ok, GET / ok, permissions ok, destination created, catalog imported
  (none) ───────────────────────────────────────────────────────────────────────────────▶ active
                                                                                           │  ▲
                                         401/403 on any call, failed probe, api_key.* + probe │  │ reconnect (new key,
                                                                                           ▼  │ same seller)
                                                                                      unauthorized
  active | unauthorized ── disconnect: delete destination (best effort), erase credentials ──▶ disconnected
```

- **`paddle_connections`** has one row per workspace that is not `disconnected`. A partial unique index on `workspace_id` enforces it.
- **Columns:**
  - `environment`: `sandbox` or `live`;
  - `seller_id`: `slr_…`;
  - `seller_name`;
  - `credential_kind`: `api_key`;
  - `api_key_envelope`;
  - `api_key_expires_on`: entered by the creator;
  - `destination_id`: `ntfset_…`;
  - `webhook_secret_envelope`;
  - `status`;
  - `status_reason`;
  - `last_event_at`;
  - `last_checked_at`;
  - `catalog_synced_at`;
  - timestamps.
- **The envelopes** are JSON text checked by `json_valid`. Their additional authenticated data is `workspaceId:connectionId:api_key` or `:webhook_secret`.
- **Reconnect** replaces the key envelope. When the seller matches, the destination stays. If the destination was deleted outside ShareRepo, a new one is created.

### Webhooks

- **Route:** `POST /webhooks/paddle/:connectionId`, matched before React Router like `/webhooks/github`, with a 1 MB body cap.
  - The handler loads the connection. A missing or `disconnected` connection gets `404`.
  - It decrypts the secret and verifies the signature (decision 0011). An invalid signature gets `401` and nothing is persisted.
  - It parses the envelope with Zod: `event_id`, `event_type`, `occurred_at`, `notification_id`, and the minimal `data.id`, `data.subscription_id` and `data.customer_id`.
  - It persists the external event and a `process_external_event` outbox row in one batch, then answers `200`. A redelivery also gets `200`.
- **`external_events` gains `connection_id`** (nullable; GitHub rows keep null) and `occurred_at`. Its provider vocabulary becomes `EVENT_PROVIDERS = ["github", "paddle"]`.
  - Deduplication is scoped to the connection: a unique index on `(provider, coalesce(connection_id, ''), external_event_id)`.
  - So a creator cannot suppress another workspace's events by signing a colliding `evt_` ID.
- **Processing** (`processPaddleEvent`) never trusts the payload's state:
  - `subscription.*`, and `transaction.*` events with a `subscription_id`, enqueue `refresh_subscription` (`paddle`, `sub_…`), deduplicated;
  - `api_key.*` enqueues `check_paddle_connection`;
  - anything else is marked processed and ignored.
- **Repair.** The daily cron enqueues `sweep_paddle_subscriptions` for each active connection.
  - The sweep lists the seller's subscriptions page by page, capped at 30 pages of 200.
  - It enqueues a refresh for each one that is unknown, or whose `updated_at` is newer than the stored `source_updated_at`.
  - It also covers events lost after Paddle's retries.

### The Paddle entitlement source

- **`refreshSubscription`** calls `GET /subscriptions/{id}` and normalizes it in `packages/integrations`. The result is a `SubscriptionSnapshot` plus a new `claimReference: string | null`.
  - `state` is Paddle's `status`. Paddle never reports `expired`.
  - `providerState` keeps the raw status.
  - `externalCustomerId` is `customer_id`.
  - `items` are the `price.id`s of active and trialing items.
  - `currentPeriodStart` and `currentPeriodEnd` come from `current_billing_period`, or are null.
  - `cancelAt` is `scheduled_change.effective_at` when `action = cancel`, otherwise null. A scheduled pause or resume is ignored until it takes effect.
  - `endedAt` is `canceled_at` when the status is `canceled`.
  - `pastDueSince` is `updated_at` when the status is `past_due`. The application keeps an earlier stored `past_due_since` while the subscription stays past due, so later updates never extend grace.
  - `sourceUpdatedAt` is `updated_at`.
  - `claimReference` is `custom_data.sharerepo_claim`: a string of at most 256 characters, otherwise null.
- **Errors.**
  - A `404` is `found: false`.
  - A `401` or `403` marks the connection `unauthorized`, through a guarded update with an audit event, and the refresh fails as `source_unavailable`. The outbox retries, and the stored facts stand.
- **The customer link** is null from Paddle. The application decides links from the claim reference (decision 0012), never from data in the snapshot.

### Claims (decision 0012)

- **Tables:**
  - `checkout_claims`: `id`, `workspace_id`, `user_id`, `offer_id`, `price_id`, `transaction_id`, `created_at`, `expires_at`, `consumed_by_customer_id`, `consumed_at`.
  - `claim_requests`: `id`, `workspace_id`, `user_id`, `email_hash`, `email_envelope` (nullable; erased after processing), `created_at`, `processed_at`.
  - `claim_tokens`: `id`, `workspace_id`, `customer_id`, `token_hash` (unique), `created_at`, `expires_at`, `consumed_at`, `consumed_by_user_id`.
  - `claim_rate_limits`: `bucket` (`email:<hash>`, `user:<id>` or `ip:<hash>`), `window_start` and `count`, like `auth_rate_limits`.
  - Every workspace-owned table uses composite foreign keys (decision 0004).
- **Linking** goes through a domain decision, `decideCustomerLink`. It takes the current subject, the proposed subject and the path, and returns `link`, `relink`, `noop` or `conflict`:
  - path 1 never relinks;
  - paths 2 and 3 do.

  The application applies the decision, the audit event, and a `recompute` of the customer's subscriptions in one batch.
- **The email hash** is HMAC-SHA256 of the lower-cased, trimmed email, keyed with `CLAIM_SIGNING_KEY`. It is used for rate limits only and is never displayed.
- **Mail port.** `MailPort.send({to, subject, text, html})`, with three implementations:
  - Cloudflare's `send_email` binding (`EMAIL`) in deployed environments;
  - an HTTP capture to the fake, accepted only when `ENVIRONMENT=e2e` (`MAIL_CAPTURE_URL`);
  - none otherwise, in which case claiming by email is reported as unavailable.

### Catalog and offers

- **`paddle_prices`:**
  - `workspace_id`, `connection_id`, `price_id`, `product_id`;
  - `product_name`, `description`;
  - `billing_interval`, `billing_frequency`, `unit_amount`, `currency`;
  - `status`, `synced_at`.
- **The catalog** is imported on connect and by "Refresh catalog", from `GET /prices?include=product` page by page. Archived prices stay, marked archived.
- **The offers page:** when Paddle is connected, offer items are chosen from active recurring prices (`source = paddle`). Simulated items remain available outside production.
  - Each Paddle offer shows its checkout page link, and the workspace's claim page link.

### Pages

| Route | Who | What |
|---|---|---|
| `/w/:slug/billing` | Owner | Connect (key, expiry date), seller and environment, status and reason, last event, catalog refresh, reconnect, disconnect, Paddle.js snippet for the default payment link |
| `/w/:slug/customers` | Owner | Paddle customers ShareRepo knows: ID, linked GitHub login or "Not claimed", subscription states; manual link with reason |
| `/buy/:offerId` | Signed-in buyer | Offer, prices, the GitHub account that will get access; POST starts checkout |
| `/c/:slug/claim` | Signed-in buyer | Email form; constant response |
| `/claim/:token` | Signed-in buyer | GET confirmation, POST claim |
| `/me/access` | Signed-in user | Their linked subscriptions across workspaces: repositories, entitlement and grant status, "accept the invitation on GitHub" link |

Public pages require sign-in. A signed-out visitor is sent through GitHub sign-in and back to the same page. Every POST is same-origin and CSRF-protected, like the existing forms.

### Audit actions (new)

- `paddle.connected`, `paddle.reconnected`, `paddle.disconnected`, `paddle.status_changed`, `paddle.catalog_synced`.
- `checkout.started`.
- `claim.requested`, `claim.token_issued`, `claim.completed`, `claim.rejected` (with a reason code), `claim.conflict`.
- `customer.relinked`, `customer.linked_manually`.
- No details carry an email, token, reference or key.

### Secrets and configuration

- **Web and jobs:**
  - `CREDENTIAL_KEYS` (the JSON keyring);
  - `CLAIM_SIGNING_KEY` (at least 32 bytes);
  - the `PADDLE_API_BASE_URL` override, accepted only in `e2e`.
- **Web:** `MAIL_CAPTURE_URL`, e2e only.
- **Jobs:** the `EMAIL` `send_email` binding, in dev and production once the sending domain is onboarded.
- **Tests** use fixed keys. The redaction canaries cover every new secret.

## Schema additions (migration 0006)

- **New tables:**
  - `paddle_connections`;
  - `paddle_prices`;
  - `checkout_claims`;
  - `claim_requests`;
  - `claim_tokens`;
  - `claim_rate_limits`.
- **`external_events`** gains `connection_id` and `occurred_at`. The provider CHECK widens to `EVENT_PROVIDERS`, and the unique index becomes the connection-scoped expression index. This is a table rebuild, tested from a populated 0005 database.
- **`outbox` kinds** add `send_claim_email`, `check_paddle_connection` and `sweep_paddle_subscriptions`. This is an outbox rebuild, as in 0005.
- **CHECKs:**
  - status and environment vocabularies;
  - envelopes are valid JSON;
  - `expires_at > created_at`;
  - a consumed claim has both its consumer and its time;
  - the token hash is 64 hex characters.

## Scenarios due by Phase 5

`pnpm check:scenarios --phase 5` enforces these.

| Scenario | Where |
|---|---|
| `webhook/duplicate-delivery-is-noop` | Paddle: the same `evt_` twice, and a replay (new `ntf_`, same `evt_`) |
| `webhook/out-of-order-does-not-regress` | Paddle: `subscription.updated` before `subscription.created`; refreshes apply only newer `updated_at` |
| `webhook/invalid-signature-rejected-before-persist` | Paddle contract and entry point: bad `h1`, stale `ts`, wrong connection's secret |
| `identity/unverified-email-match-grants-nothing` | Service: a user whose GitHub email equals the Paddle email gets nothing without a claim |
| `identity/unlink-relink-moves-subject-safely` | Service: a path 2 claim moves the customer, and the old subject's entitlements end |
| `claim/token-single-use-and-expiring` | Service |
| `claim/get-never-mutates` | Entry point |
| `claim/request-does-not-reveal-purchases` | Service: the same response and audit shape with and without a match |
| `claim/request-rate-limited` | Service |
| `timing/renewal-during-scheduled-revocation` | Service: scheduled cancel, then the cancel is removed before the effective time; access stays |
| `timing/cancellation-revokes-at-effective-time` | Service, with the Paddle source |
| `timing/past-due-within-grace-keeps-access` | Service, with the Paddle source; an update while past due does not extend grace |

New scenarios added to the catalog in Phase 5:
- `claim/checkout-reference-tamper-rejected` (Service): a forged, other-workspace, expired or other-customer reference links nothing.
- `connection/revoked-key-keeps-last-facts` (Service): a 403 marks the connection unauthorized, and entitlements are unchanged.
- `credential/envelope-bound-to-row` (Platform and DB): a copied envelope fails to decrypt; master-key rotation re-wraps.

## Tasks and parallelisation

Same method as Phases 2–4:
- the lead does T1;
- T2, T3 and T4 run in parallel worktrees, each first merging `phase-5/paddle`;
- then T5;
- then T6 and T7 in parallel;
- then T8.

```text
T1 schema + migration + vocabularies + env ──┬─ T2 domain: links, claims, connection, audit ─────┐
                                             ├─ T3 integrations: Paddle client, webhook, fake ────┼─ T5 application ─┬─ T6 web ──┐
                                             └─ T4 platform + db: envelopes, MACs, repositories ─┘                  └─ T7 jobs ─┴─ T8 E2E, docs, verification
```

### T1 — Schema, migration, vocabularies, configuration (lead)

- Migration 0006 and the Drizzle schema, with the rebuild tests.
- **Vocabularies:** `EVENT_PROVIDERS`, the new outbox kinds, the connection status, environment and credential kind, the claim rejection reasons, and the audit action names (definitions come in T2).
- Placeholder `runJob` cases.
- Env schemas and wrangler bindings for the new secrets and overrides, with typegen.

### T2 — Domain (parallel)

- `decideCustomerLink`.
- **Claim rules:** `checkoutClaimUsable` (expiry, consumer) and `claimTokenUsable`.
- The rate-limit policy, with windows and limits as data.
- **Connection status transitions:** `nextConnectionStatus` from a probe or call outcome.
- The `pastDueSince` carry-over rule in snapshot application.
- The audit action definitions.
- Property tests; 100% coverage and mutation score.

### T3 — Integrations (parallel)

- **The Paddle client:**
  - `getApiRoot`, `listPrices`, `getSubscription`, `listSubscriptions`, `listCustomersByEmail`, `getCustomer`;
  - `createTransaction`, `createNotificationSetting`, `getNotificationSetting`, `deleteNotificationSetting`;
  - Zod response schemas, pagination, the error classification table, a 20 s timeout and `Paddle-Version: 1`.
- **Webhooks:** the signature verifier, using a constant-time comparison over multiple `h1` values with a tolerance window, and the envelope parser.
- **The subscription normalizer**, and the key-format validator.
- **`FakePaddle`** (in-memory, behind the port) with controls: subscription lifecycle, signed event emission, fault injection, and a 10-destination limit.
- The contract suite against the fake and recorded fixtures.
- The mail port with its binding and HTTP-capture implementations.

### T4 — Platform and database (parallel)

- **Platform:**
  - `sealSecret` and `openSecret` (envelopes, keyring, re-wrap signal);
  - `claimReference` and `verifyClaimReference`;
  - `hashClaimEmail`;
  - token generation and hashing;
  - redaction keys.
- **Repositories:**
  - Paddle connections: create, guarded status update, reconnect, disconnect, lookup by ID for webhooks.
  - Prices: upsert and list.
  - Checkout claims, claim requests and tokens: create, consume with guarded single use, erase email.
  - Rate-limit buckets.
  - External events with a connection.
  - Customers: list with link, apply link and relink.
- Conformance, isolation and composite foreign key tests.

### T5 — Application (after T2–T4)

- **Connections:** `connectPaddle`, `reconnectPaddle`, `disconnectPaddle`, `checkPaddleConnection`, `syncPaddleCatalog`.
- **Events:** `ingestPaddleWebhook`, `processPaddleEvent`, and `paddleEntitlementSource`, which carries the claim reference into the refresh's linking step.
- **Checkout and claims:** `startCheckout`, `requestClaim`, `sendClaimEmail`, `viewClaim`, `confirmClaim`, `linkCustomerManually`.
- **Views:** `listCustomers` and `myAccess`.
- **Repair:** `sweepPaddleSubscriptions`.
- Service scenarios, isolation for every read and write, and audit completeness.

### T6 — Web (after T5)

- **Routes:** billing, customers, buy, claim request, claim confirmation, and my access.
- The webhook entry point, and `Referrer-Policy` on claim pages.
- Navigation entries and copy ("repository", "subscriber", "purchase").

### T7 — Jobs (after T5)

- **Handlers:** `process_external_event` for Paddle, `refresh_subscription` with the Paddle source, `send_claim_email`, `check_paddle_connection`, `sweep_paddle_subscriptions`.
- The daily cron enqueues the sweeps.
- Wiring for the `EMAIL` binding and the mail port.

### T8 — E2E, docs, verification

- **The E2E fake Paddle server** (port 5191):
  - API endpoints;
  - a default payment link page whose "Pay" button creates the customer and subscription, then sends signed webhooks;
  - lifecycle controls;
  - a mailbox.
- **Journeys:**
  - connect, then the catalog shows;
  - buy, invitation, accept, active;
  - a cancellation scheduled in Paddle revokes at its effective time (fake clock control);
  - a purchase via a direct Paddle link, claimed by email, gives access;
  - a revoked key shows "Reconnect".
- **Docs:**
  - `integrations.md` (Paddle in v1, the error table), `domain-model.md` (claims), `product.md` (subscriber journey), `local-setup.md`;
  - `deployment.md` (secrets, the email domain);
  - a new runbook, `paddle-sandbox-setup.md`, with a live sandbox check to run before merge;
  - the threat model, marked implemented;
  - `implementation-plan.md` resolves the Paddle deferred decision.
- CI moves to `CURRENT_PHASE: "5"`.

## Acceptance criteria

| Criterion | Proven by |
|---|---|
| A Paddle sandbox purchase can be claimed by the correct subscriber and grants the mapped repository access | Fake-backed E2E. The sandbox check needs a human: the runbook, before merge |
| Duplicate and out-of-order webhooks converge correctly | `webhook/*` scenarios, isolation of event IDs by connection |
| Failed payment applies grace policy rather than unconditional immediate revocation | `timing/past-due-within-grace-keeps-access` with the Paddle source; `transaction.payment_failed` only triggers a refresh |
| Effective cancellation revokes at the intended time | `timing/cancellation-revokes-at-effective-time`, E2E |
| Renewal or reactivation during a grace or cancellation period prevents stale revocation | `timing/renewal-during-scheduled-revocation` |
| Credential rotation and connection loss are handled without secret leakage | Reconnect tests, `connection/revoked-key-keeps-last-facts`, `credential/envelope-bound-to-row`, redaction canaries |

## Risks and open points

- **Unconfirmed Paddle behaviour**, which the sandbox check must settle:
  - whether retries carry a fresh `ts`;
  - the size limits on `custom_data`;
  - the maximum page size;
  - whether `GET /customers?email=` matches exactly.
- **Shared egress and Paddle's per-IP rate limit.** A `429` is retried after `Retry-After`. A burst of webhooks could still trip it across tenants.
- **Email is beta.** If Cloudflare Email Service is unavailable, path 2 degrades to "unavailable" and path 3 remains.
- **A buyer who never signs in** has paid but has no access until they claim. The receipt email comes from Paddle, so the creator must tell buyers about `/c/<slug>/claim`.
