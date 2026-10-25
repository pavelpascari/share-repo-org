# Paddle Billing for ShareRepo

Research date: 2026-10-24. Primary sources only: developer.paddle.com (Paddle Billing, not Paddle Classic), paddle.com/help, and developers.cloudflare.com. Items that no primary source confirms are marked **UNCONFIRMED**.

Paddle's docs serve a Markdown copy of each page at `<url>.md`. The index is at https://developer.paddle.com/llms.txt.

## Summary: decisions and implications

| # | Finding | Implication for ShareRepo |
|---|---|---|
| 1 | Paddle launched OAuth "apps" on 2026-06-26. To get one, a developer applies to an app marketplace publisher program. The public docs do not cover the OAuth endpoints, scopes, token lifetimes or approval criteria. | Apply to the publisher program now. Build the private launch on **seller-created API keys** as the temporary connection variant that `integrations.md` already allows. Keep the connection model ready for an `oauth` credential kind. |
| 2 | API keys are 69 characters long, start with `pdl_live_apikey_` or `pdl_sdbx_apikey_`, and carry granular permissions. They expire after 90 days by default and after one year at most. Manual rotation means creating a new key. | Validate the key format with Zod. Infer the environment from the prefix. Store the key as an encrypted envelope. Model key expiry as connection health and warn ahead of time. Reconnecting means pasting a new key. |
| 3 | `GET /` (API root) needs no permission. It returns the environment, `caller.auth_type`, `caller.account.id` (`slr_…`) and `caller.permissions[]`. | Call it during connect. Persist `slr_…` as the seller account's external ID. Reject the key if a required permission is missing or the environment is wrong. Re-check on every health probe. |
| 4 | Notification destinations can be created through the API (`POST /notification-settings`). The response includes `endpoint_secret_key`. Only **10 destinations can be active per account**. | Register the webhook destination automatically. Store `ntfset_…` and the secret as an encrypted envelope. Tell the creator that ShareRepo uses one of their 10 slots. |
| 5 | The API offers no secret rotation for a destination. Multiple `h1` values are described as possible "in the future". | Rotate by creating a new destination, verifying against both secrets for an overlap window, then deleting the old one. The verifier should accept any matching `h1`. |
| 6 | The signature is `Paddle-Signature: ts=…;h1=…`, an HMAC-SHA256 of `ts + ":" + rawBody`. The SDK default tolerance is 5 s. Paddle expects a 200 within 5 s. Live retries reach up to 60 attempts over about 2 days. Delivery is at least once and not ordered. | Verify on the raw body before parsing and persist before acking. Dedupe on `event_id` and order by `occurred_at`. The sandbox only retries 3 times in about 2 minutes, so tests must not depend on sandbox retries. |
| 7 | `notification_setting.write` and `notification.read` reach the payloads of **every** entity, whatever the key's other permissions. | Requesting these permissions means ShareRepo can see all of the creator's Paddle event data. Say so plainly in the connect UI. Minimise and redact what ShareRepo stores. |
| 8 | `custom_data` on a checkout or transaction is copied to the created subscription, and from the subscription to later transactions. It appears in webhooks. | Purchase claim path 1 works. Put the HMAC-signed claim reference in `custom_data`. Values that come from Paddle.js are client-controlled, and the threat model already treats them as untrusted until the signature is verified. |
| 9 | `past_due` keeps the subscription billable. Automatic retries run up to 7 times over 30 days on live only. When retries are exhausted, the subscription is paused or canceled, depending on the seller's settings. | The per-offer grace policy (decision 0009) stays authoritative in ShareRepo. Never revoke on `transaction.payment_failed`. Sandbox has no payment retries, so dunning must be simulated in tests. |
| 10 | In live, checkout only loads on domains that Paddle has **approved for that seller**. Hosted checkout (`pay.paddle.io`) needs extra approval and targets mobile apps. | ShareRepo cannot open a checkout for a seller's price on `sharerepo.org` unless each seller gets `sharerepo.org` approved. Whether Paddle would approve that is **UNCONFIRMED**. The safe default is to create the transaction server-side and redirect to its `checkout.url`, which is on the seller's own approved domain. |
| 11 | The rate limit is **240 requests per minute per IP address**. A 429 blocks that IP for 60 s. | Cloudflare Workers share egress IPs. Whether other tenants' traffic or other Cloudflare customers count against the same Paddle limit is **UNCONFIRMED**. Throttle centrally, honour `Retry-After`, and prefer webhooks and `include` over polling. |
| 12 | Cloudflare Email Service "Email Sending" is in **public beta** (since 2026-04-16). It is available on Workers Paid through a `send_email` binding, and can send to any recipient once a sending domain is onboarded. | It is a viable first choice for the claim-later one-time link. Keep it behind a mail adapter so another provider can replace it while the service is in beta. |

## 1. Connecting a third-party seller account

### OAuth apps ("Apps for Paddle")

- On **2026-06-26**, Paddle announced "Build apps for Paddle using OAuth". The changelog says "OAuth for connecting apps to Paddle accounts is available now."
- How it works for sellers: connected apps appear under **Paddle > Connectors > Apps**. "Each app connects with its own credentials and only the permissions you approve, and you can review or revoke an app's access at any time."
- Paddle's guidance on when to use it: "If you're implementing Paddle in your stack as your merchant of record, you should use API keys. OAuth is for building apps that other Paddle users can install." ShareRepo is the second case: creators install it.
- **Approval:** a developer must "apply to the app marketplace publisher program" using the form on the apps guide. The apps guide says Paddle will share how the program works after you apply. "A marketplace where you can discover and install apps is coming soon."
- The public docs give no authorization or token URL, scopes, PKCE support, refresh-token behaviour, token lifetime, sandbox support or approval criteria. **UNCONFIRMED:** all OAuth mechanics, whether an app can stay unlisted or private, and whether an OAuth token may call `/notification-settings`.
- The API root documents `caller.auth_type = "oauth"`. Its example is the live Paddle MCP server connection. That connection starts with read access, and Paddle may ask users to reauthorize "from time to time". The live MCP server has supported OAuth since 2026-08-04, and the sandbox MCP server still uses API keys. **UNCONFIRMED** whether third-party OAuth apps work in sandbox.

### Embedded billing (partner API)

- This is a separate path for platforms that onboard *new* sellers from their own UI. Paddle is the merchant of record for each seller. Access requires joining the partner program. After that, "The Paddle team then unlocks the docs".
- The public page does not say whether it can connect *existing* seller accounts, or how credentials and webhooks work per seller (**UNCONFIRMED**). It does not fit ShareRepo's model, where creators bring their own Paddle account.

### API keys (what works today without approval)

- **Format:** 69 characters, matching `^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$`. Keys are case-sensitive.
  - `pdl_live_` marks a live key and `pdl_sdbx_` a sandbox key.
  - `apikey_` distinguishes an API key from a client-side token.
- **Legacy keys:** keys created before 2025-05-06 are 50-character strings without permissions. They still work and have no deprecation date. ShareRepo should refuse them, because their access cannot be scoped.
- **Header:** `Authorization: Bearer pdl_…`.
- **Permissions:** each permission is `entity.read` or `entity.write`, and write includes read. A request without the needed permission gets `403 forbidden`.
- **Expiry:**
  - The creation steps ask for an expiry date. The default is 90 days and the maximum is one year.
  - The same page also says "You don't have to set an expiry date". Whether a key can be created without any expiry is **UNCONFIRMED**.
  - An expired key "can't be revalidated".
- **Webhooks about keys:** `api_key.expiring` (seven days before expiry), `api_key.expired`, `api_key.revoked`, `api_key.created`, `api_key.updated`. Keys exposed publicly, for example in a public GitHub repo, are revoked automatically.
- **Rotation:**
  - Only keys marked **Rotatable** when created can be rotated in place, and this cannot be changed later.
  - Automatic rotation runs only through AWS Secrets Manager. During its grace period both secrets work.
  - Otherwise, rotation means "create a new key and transition to it". ShareRepo cannot rotate a seller's key itself, so the creator has to paste a new one.
- A key is visible only once, when it is created.

### Identifying the seller behind a key

- `GET /` (API root) needs **no permission**:
  - It returns `data.api.environment` (`production` or `sandbox`), `data.caller.auth_type` (`api_key`, `oauth`, `client_token`, `session`), `data.caller.account.id` (`slr_…`), `data.caller.account.name` and `data.caller.permissions[]`.
  - A request with an invalid key returns 403. A request without credentials returns `account: null`.
- `GET /account` (`account.read`) returns `id` (`slr_…`, pattern `^slr_[a-z\d]{26}$`), `legacy_id` (numeric, for support), `legal_name`, `display_name`, `website` and `email`. Sandbox and live accounts are separate entities.
- These operations shipped on 2026-10-20. Existing keys do not inherit the new permissions.

### Permissions ShareRepo needs

| Need | Permission |
|---|---|
| Identify account and check permissions | none (`GET /`) |
| Read products | `product.read` |
| Read prices | `price.read` |
| Read customers (email, id) | `customer.read` |
| Read subscriptions | `subscription.read` |
| Read transactions | `transaction.read` |
| Create, update and delete the webhook destination | `notification_setting.write` (includes read) |
| Backfill and repair from `/events`, `/notifications` | `notification.read` (optional) |
| Replay failed notifications | `notification.write` (optional) |
| Create a transaction to start a checkout (section 5) | `transaction.write` (optional) |
| Read default payment link and checkout domains (section 5) | `checkout_settings.read`, `checkout_domain.read` (optional) |
| Create a client-side token for Paddle.js | `client_token.write` (optional) |
| Show account display name | `account.read` (optional) |

Warning from Paddle: `notification_setting.write` and `notification.read` "give access to payloads for every entity that has events", whatever the key's other permissions. Destinations "keep receiving notifications after the API key that created them is revoked". On disconnect, ShareRepo must delete its destination explicitly.

Sources:
- https://developer.paddle.com/changelog/2026/build-apps-for-paddle
- https://developer.paddle.com/sdks/apps
- https://developer.paddle.com/partners/about
- https://developer.paddle.com/partners/embed-billing
- https://developer.paddle.com/changelog/2026/paddle-mcp-oauth
- https://developer.paddle.com/api-reference/about/authentication
- https://developer.paddle.com/api-reference/about/rotate-api-keys
- https://developer.paddle.com/changelog/2025/api-key-improvements
- https://developer.paddle.com/api-reference/about/permissions
- https://developer.paddle.com/api-reference/api-root/get-api-root
- https://developer.paddle.com/api-reference/account/get-account
- https://developer.paddle.com/changelog/2026/account-settings-api

## 2. Notification destinations

- **Create:** `POST /notification-settings` (`notification_setting.write`). Request fields:
  - `description` (required, 1–500 characters).
  - `type` (required): `url` or `email`.
  - `destination` (required, 1–2048 characters).
  - `subscribed_events` (required): an array of event type names. Paddle returns full event-type objects.
  - `api_version` (integer). Defaults to the account default and cannot be older than it.
  - `include_sensitive_fields` (default `false`).
  - `traffic_source`: `platform` (default), `simulation` or `all`.
- **Response (201):**
  - `id` (`ntfset_…`), `active` (default `true`) and the fields above.
  - **`endpoint_secret_key`**, matching `^pdl_ntfset_[a-zA-Z0-9]{26}_[a-zA-Z0-9]{32}$`.
  - List, get and update also return the secret.
- **Update:** `PATCH /notification-settings/{id}`. `subscribed_events` replaces the whole list, so omitted events are removed. Use `active: false` to deactivate.
- **Delete:** `DELETE /notification-settings/{id}`. It is permanent, and the logs for that destination are lost.
- **Limit:** "You can create as many notification destinations as you want, but only 10 can be active at once."
- **Secret rotation:** no API operation regenerates `endpoint_secret_key` (**UNCONFIRMED** that none exists). The signature docs say multiple `h1` values will appear during rotation "in the future". In the meantime, rotate by creating a new destination, overlapping, then deleting the old one.
- **`include_sensitive_fields`:** the API describes it only as "potentially sensitive fields". Which fields it covers is **UNCONFIRMED**. Leave it `false`. Customer `email` is present in `customer.*` payloads either way.
- Webhook destinations do not use the account's default API version. Pin `api_version: 1`.

Sources:
- https://developer.paddle.com/api-reference/notification-settings/create-notification-setting
- https://developer.paddle.com/api-reference/notification-settings/update-notification-setting
- https://developer.paddle.com/api-reference/notification-settings/delete-notification-setting
- https://developer.paddle.com/webhooks/about/notification-destinations
- https://developer.paddle.com/api-reference/about/versioning

## 3. Webhook verification and delivery

- **Header:** `Paddle-Signature: ts=1671552777;h1=eb4d0d…`. Split on `;`, then on `=`. `ts` is a Unix timestamp. "Signatures contain at least one `h1`."
- **Signed payload:** `ts + ":" + rawBody`. Use the raw body exactly as received.
- **Hash:** HMAC-SHA256 keyed with the destination's `endpoint_secret_key`. Compare the hex digest with `h1`. Use a constant-time comparison (our practice; Paddle does not mention it).
- **Timestamp tolerance:** Paddle sets no fixed value. Its SDK default is **5 seconds**, and the docs recommend a similar check. Whether retries carry a fresh `ts` is **UNCONFIRMED**. The 5 s SDK default implies they do.
- **Multiple `h1` values:** only promised for future secret rotation. Accept the delivery if any `h1` matches any active secret.
- **Response:** return HTTP **200 within 5 seconds**, then process asynchronously.
- **Retries:**
  - Live: up to **60 attempts over about 2 days**, about 10 in the first hour and about 45 in the first day. The wait before each attempt is 60 × n^1.1 seconds.
  - Sandbox: **3 attempts within about 2 minutes**.
  - After the last attempt the notification status is `failed`.
- **Ordering:** "We can't guarantee the order of delivery for webhooks."
- **Duplicates:** delivery is at least once. Dedupe on `event_id`.
- **Payload envelope:**
  - `event_id` (`evt_…`), `event_type` (`entity.action`).
  - `occurred_at` (RFC 3339).
  - `notification_id` (`ntf_…`).
  - `data`: a snapshot of the entity when the event occurred.
- **Event versus notification:**
  - One event creates one notification per destination. Those notifications share an `event_id` and have different `notification_id`s.
  - A replay creates a new notification for the same `event_id`.
  - The dedupe key is therefore `event_id`, scoped to the connection.
- **Replay:** `POST /notifications/{notification_id}/replay` (`notification.write`, 202). It works on `delivered` or `failed` notifications whose `origin` is `event`. A replay cannot itself be replayed.
- **Repair:** `GET /events` lists events with filters `event_type`, `from`, `to`, and `filter` (an ID or email). `GET /notifications` and `/notification-logs` are also available. Events and notifications **older than 90 days are not returned**.
- **Source IPs:**
  - Sandbox: 34.194.127.46, 54.234.237.108, 3.208.120.145, 44.226.236.210, 44.241.183.62, 100.20.172.113.
  - Live: 34.232.58.13, 34.195.105.136, 34.237.3.244, 35.155.119.135, 52.11.166.252, 34.212.5.7.
  - These are optional defence in depth on top of the signature check.

Sources:
- https://developer.paddle.com/webhooks/about/signature-verification
- https://developer.paddle.com/webhooks/about/respond-to-webhooks
- https://developer.paddle.com/webhooks/about/how-webhooks-work
- https://developer.paddle.com/api-reference/notifications/replay-notification
- https://developer.paddle.com/api-reference/events/list-events
- https://developer.paddle.com/changelog/2024/event-notification-retention-changes

## 4. Events and entities

### Relevant event types

| Event | When |
|---|---|
| `subscription.created` | When an automatically-collected transaction completes, or a manually-collected one is billed. Only this event carries `transaction_id`. |
| `subscription.trialing` / `subscription.activated` | Enters trial / becomes `active`: any trial has ended and Paddle has billed the customer. |
| `subscription.updated` | Any change: items, scheduled change created or removed, billing period, and status changes that have no dedicated event. It may follow a lifecycle event immediately. |
| `subscription.past_due` | The subscription has an unpaid transaction. |
| `subscription.paused` / `subscription.resumed` | Paused, either immediately or when a scheduled change takes effect. On resume Paddle bills immediately. |
| `subscription.canceled` | Status becomes `canceled`. A cancellation at the end of the period first fires `subscription.updated` with a scheduled change. |
| `subscription.imported` | An imported subscription. |
| `transaction.paid` | Payment captured. Processing is not finished, and `subscription_id` may still be missing. |
| `transaction.completed` | Processing done. For automatic collection, the subscription has been created and `subscription_id` set. |
| `transaction.payment_failed` | A payment attempt failed. For a renewal, the transaction becomes `past_due`. |
| `customer.created` / `customer.updated` | Name, email, locale or marketing consent changed. |

Subscription event payloads omit `management_urls`, which must be fetched through the API.

### Subscription entity (fields ShareRepo uses)

- `id` (`sub_…`), `customer_id` (`ctm_…`), `address_id`, `business_id`.
- **`status`:**
  - `active`.
  - `trialing`.
  - `past_due`: set when an automatically-collected payment fails, or when an invoice is still unpaid 24 h after its due date.
  - `paused`.
  - `canceled`.
- `created_at`, `updated_at`, `started_at`, `first_billed_at`, `next_billed_at`, `paused_at`, `canceled_at` (RFC 3339 or `null`).
- **`current_billing_period`** `{starts_at, ends_at}`. It is `null` for `paused` and `canceled` subscriptions.
- **`scheduled_change`** `{action: cancel|pause|resume, effective_at, resume_at}` or `null`.
- `billing_cycle {interval, frequency}`, `collection_mode` (`automatic` or `manual`).
- **`items[]`:** `status` (`active`, `inactive`, `trialing`), `quantity`, `price.id` (`pri_…`), `price.product_id` (`pro_…`), `next_billed_at`, `trial_dates`.
- **`custom_data`** (object or `null`).

### custom_data propagation

- A checkout passes `customData` (Paddle.js) or `data-custom-data` (HTML attribute). The data "is held against the related transaction".
- A transaction can also be created or updated through the API with `custom_data`.
- When a subscription is created from a transaction with recurring prices, the transaction's custom data "is copied to the created subscription". Subscription custom data is in turn copied to renewal, upgrade, downgrade and one-time transactions.
- `Paddle.Checkout.updateCheckout({customData})` replaces custom data on an open checkout. The buyer's browser can therefore change it. Treat it as untrusted (threat model T11).
- Rules: it must be valid JSON with at least one key, and Paddle advises against nesting. **UNCONFIRMED:** size or key limits. None are documented.
- Custom data appears in webhooks and API responses.

### Customer entity

- `id` (`ctm_…`), `email` (required), `name`, `marketing_consent`, `status`, `custom_data`, `locale`, `created_at`, `updated_at`.
- The email can change (`customer.updated`). This supports threat model T9: link to `ctm_…`, not to the email.

### past_due and dunning

- For live automatically-collected subscriptions, Paddle retries the saved payment method up to **7 times over 30 days**. A successful retry returns the subscription to `active`.
- When retries are exhausted, the subscription "is paused or canceled, depending on your settings". The 2025 changelog says it is canceled after 30 days if the customer does not update the payment method. The outcome depends on the seller's Retain Payment Recovery configuration.
- The sandbox has **no payment retries**.
- Manually-collected subscriptions are never retried, paused or canceled automatically.
- Paddle's own provisioning guide gives `past_due` full access and `paused` none or read-only. For `canceled` with a future `scheduled_change.effective_at`, access stays until that time.

Sources:
- https://developer.paddle.com/api-reference/subscriptions/get-subscription
- https://developer.paddle.com/api-reference/customers/get-customer
- https://developer.paddle.com/webhooks/subscriptions/subscription-created
- https://developer.paddle.com/webhooks/subscriptions/subscription-updated
- https://developer.paddle.com/webhooks/subscriptions/subscription-past-due
- https://developer.paddle.com/webhooks/subscriptions/subscription-canceled
- https://developer.paddle.com/webhooks/subscriptions/subscription-paused
- https://developer.paddle.com/webhooks/subscriptions/subscription-resumed
- https://developer.paddle.com/webhooks/subscriptions/subscription-activated
- https://developer.paddle.com/webhooks/transactions/transaction-completed
- https://developer.paddle.com/webhooks/transactions/transaction-paid
- https://developer.paddle.com/webhooks/transactions/transaction-payment-failed
- https://developer.paddle.com/webhooks/customers/customer-updated
- https://developer.paddle.com/build/transactions/custom-data
- https://developer.paddle.com/api-reference/about/custom-data
- https://developer.paddle.com/changelog/2025/update-checkout-custom-data
- https://developer.paddle.com/changelog/2025/default-dunning-payment-recovery
- https://developer.paddle.com/build/subscriptions/provision-access-webhooks

## 5. Checkout

- **Paddle.js overlay and inline checkout:**
  - `Paddle.Initialize({ token })` takes a client-side token: `test_` or `live_` followed by 27 characters. Paddle says the token is safe to publish and is limited to opening checkouts and previewing prices and transactions.
  - Tokens can be created through the API (`POST /client-tokens`, `client_token.write`).
  - `Paddle.Checkout.open({ items | transactionId, customData, customer, settings })`.
- **Domain requirement:**
  - A live account needs a default payment link "on an approved domain". In sandbox, "checkout opens on any domain, including `localhost`".
  - Paddle "reviews each domain before it can be used to load a checkout, so customers can only purchase from sites you control".
  - Domains are submitted only in the dashboard (**Settings > Website approval**). The API can list checkout domains and their status but not add them.
  - Review criteria: product description, pricing, features, Terms, Refund and Privacy policies, HTTPS, and only domains related to the product sold.
- **Default payment link:**
  - It is required before any transaction can be created.
  - It is used for `checkout.url` (`<link>?_ptxn=txn_…`), for payment-method update links, and in Paddle's emails.
  - It must be a page that includes Paddle.js, which opens the checkout automatically.
  - Since 2026-10-20 it is readable and settable through `/settings/checkout-url` (`checkout_settings.*`). Setting it requires an approved domain (`checkout_url_domain_not_approved`).
- **Hosted checkout (`pay.paddle.io`):**
  - "Hosted checkout requires additional approval to use on live accounts". Access is requested by email and is aimed at mobile apps.
  - Query parameters include `price_id`, `transaction_id`, `user_email`, `paddle_customer_id` and `app_user_id`. **No `custom_data` parameter is documented.**
  - Custom subdomains (`<name>.paddle.io`) also need approval.
- **Payment links:** in Paddle Billing, a "payment link" is the transaction `checkout.url` built from the default payment link. I found no standalone payment-link product.
- **Can ShareRepo host checkout on its own domain for a seller's price?**
  - Only if each seller adds `sharerepo.org`, or a per-creator subdomain, to *their* Paddle website approval and Paddle approves it.
  - Paddle's help centre does not address ownership or third-party platforms. Approval is **UNCONFIRMED** and looks doubtful under "sites you control" and "relevance".
- **Can ShareRepo create a transaction through the API with `custom_data` and send the buyer to its checkout URL?**
  - Yes, and the docs support it. `POST /transactions` (`transaction.write`) accepts `items[].price_id`, `custom_data` and optionally `checkout.url`, which must be an approved domain or `null` for the default.
  - The response's `checkout.url` points at the seller's default payment link page with `?_ptxn=`.
  - Requirements on the seller: a default payment link that loads Paddle.js on an approved domain. The custom data is then set server-side, which is stronger than client-side `customData`. The buyer's browser can still call `updateCheckout`, so the HMAC on the claim reference remains necessary.

Sources:
- https://developer.paddle.com/paddle-js/about/client-side-tokens
- https://developer.paddle.com/api-reference/client-tokens/create-client-token
- https://developer.paddle.com/paddle-js/methods/paddle-checkout-open
- https://developer.paddle.com/build/checkout/build-overlay-checkout
- https://developer.paddle.com/build/transactions/default-payment-link
- https://developer.paddle.com/build/transactions/pass-transaction-checkout
- https://developer.paddle.com/api-reference/transactions/create-transaction
- https://developer.paddle.com/api-reference/checkout-domains
- https://developer.paddle.com/errors/accounts/checkout_url_domain_not_approved
- https://developer.paddle.com/paddle-js/about/hosted-checkout
- https://developer.paddle.com/changelog/2025/custom-subdomains-hosted-checkout
- https://www.paddle.com/help/start/account-verification/what-is-domain-approval

## 6. API basics

- **Base URLs:** live `https://api.paddle.com`, sandbox `https://sandbox-api.paddle.com`. Sandbox and live are separate accounts with separate IDs, keys, catalogs and notification destinations.
- **Auth:** `Authorization: Bearer <api key>`.
- **Versioning:** the `Paddle-Version: 1` header. Version 1 is current. Without the header, the account default applies. A version earlier than the account default cannot be used. Paddle does not upgrade versions automatically and does not currently deprecate old versions.
- **Pagination:**
  - Cursor-based. `meta.pagination` holds `{per_page, next, has_more, estimated_total}`.
  - `next` is a full URL with `after=<last id>`. Paddle always returns `next`, so loop on `has_more`.
  - The default order is `id[DESC]`. `order_by=id[ASC]` reverses it.
  - The `Skip-Count: true` header skips the count and returns `estimated_total = -1`.
  - The maximum `per_page` varies by endpoint (an example shows 200 for notification settings). It is 200 for prices, customers and subscriptions (§ 8).
- **Default scopes:** most lists return only `active` entities. Subscriptions, transactions, notifications and notification settings return all.
- **Rate limits:**
  - **240 requests per minute per IP address.**
  - 1,000 per minute for transaction and price previews.
  - A 429 `too_many_requests` blocks the IP for 60 s and carries a `Retry-After` header.
  - Subscription immediate charges are limited to 20 per hour and 100 per 24 h per subscription.
- **Errors:** `{ "error": { "type": "request_error" | "api_error", "code", "detail", "documentation_url", "errors"?: [{field, message}] }, "meta": { "request_id" } }`. 4xx means a request problem. For 5xx, retry with exponential backoff. Log `request_id`.
- **Filters useful for reconciliation:** `GET /subscriptions?customer_id=&price_id=&status=&scheduled_change_action=`.

Sources:
- https://developer.paddle.com/sdks/sandbox
- https://developer.paddle.com/api-reference/about/versioning
- https://developer.paddle.com/api-reference/about/pagination
- https://developer.paddle.com/api-reference/about/default-scopes
- https://developer.paddle.com/api-reference/about/rate-limiting
- https://developer.paddle.com/api-reference/about/errors
- https://developer.paddle.com/api-reference/subscriptions/list-subscriptions

## 7. Email from a Worker (claim-later link)

- **Cloudflare Email Service, Email Sending:** in **public beta since 2026-04-16**. Authenticated SMTP has been in beta since 2026-06-08. The docs page was last updated 2026-10-15.
- **Workers binding:**
  - `send_email` in Wrangler, called as `env.EMAIL.send({ to, from, subject, html, text })`. It returns `{ messageId }` and throws an `Error` with a `code` on failure.
  - The sender must be on an onboarded Email Service domain.
  - Options can restrict the binding (`destination_address`, `allowed_destination_addresses`, `allowed_sender_addresses`).
  - A REST API is also available.
- **Arbitrary recipients:**
  - Sending to any recipient requires **Workers Paid** and an onboarded sending domain. Before onboarding, only verified destination addresses work.
  - "After you onboard a sending domain, you can send to any recipient immediately."
  - The send-bindings page says a binding without restrictions sends "to any verified destination address". Taken with the limits page, this reads as applying before onboarding. **UNCONFIRMED** until tested.
- **Limits:**
  - The daily quota is conservative for new accounts and grows with reputation. The exact numbers are not published (**UNCONFIRMED**).
  - Each email allows 50 recipients and 5 MiB, and headers may total 16 KB.
- **Pricing:** 3,000 emails a month are included on Workers Paid, then $0.35 per 1,000.
- **Policy:** "Email Service supports transactional email only". A claim link qualifies.
- Bounce, complaint and suppression events can be delivered to Queues.
- **The older Email Routing `send_email`** (as opposed to Email Sending) only reaches verified destination addresses. It is not suitable for buyers.

Sources:
- https://developers.cloudflare.com/email-service/
- https://developers.cloudflare.com/email-service/platform/limits/
- https://developers.cloudflare.com/email-service/platform/pricing/
- https://developers.cloudflare.com/email-service/configuration/send-bindings/
- https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- https://developers.cloudflare.com/email-service/platform/changelog/
- https://developers.cloudflare.com/email-service/reference/faq/

## 8. Confirmed while building the client (Phase 5, T3)

These were settled from Paddle's API reference while writing the client and its fixtures. The live sandbox check ([runbook](../runbooks/paddle-sandbox-setup.md) § 9) still has to confirm them against real responses.

- **API root:** `GET /` returns `data.caller.account` as `{ id, name }` (`slr_…` and the account's name), `null` without credentials. `data.api.environment` is `production` or `sandbox`.
- **Destination limit:** creating an 11th active notification setting fails with `400` and `error.code` `notification_maximum_active_settings_reached`.
- **No default payment link:** `POST /transactions` fails with `400` and `error.code` `transaction_default_checkout_url_not_set`.
- **Page size:** `per_page` goes up to 200 for prices, customers and subscriptions (default 50).
- **Email filter:** `GET /customers?email=` takes a comma-separated list of addresses and matches each exactly. ShareRepo sends one address and refuses input containing a comma.

Sources:
- https://developer.paddle.com/api-reference/overview
- https://developer.paddle.com/api-reference/notification-settings/create-notification-setting
- https://developer.paddle.com/api-reference/transactions/create-transaction
- https://developer.paddle.com/api-reference/customers/list-customers
- https://developer.paddle.com/api-reference/subscriptions/list-subscriptions

## 9. Listing notification settings (Phase 6 risk fixes, from the API reference, 2026-10-25)

- `GET /notification-settings` takes `after`, `per_page` (default and maximum 200), `order_by` (`id[ASC]` or `id[DESC]`, default `id[DESC]`), `active` and `traffic_source`. Its response has `meta.pagination` like the other lists.
- Each item has `id`, `description` (1–500 characters, "shown in the Paddle dashboard"), `type`, `destination`, `active`, `api_version`, `include_sensitive_fields`, `subscribed_events`, `endpoint_secret_key` and `traffic_source`. **There is no creation time**, so ShareRepo writes its own into the description.
- The list includes `endpoint_secret_key` for every setting, other apps' too. The client's schema drops it; it is never stored or logged.

Sources:
- https://developer.paddle.com/api-reference/notification-settings/list-notification-settings

Still **UNCONFIRMED**, for the live sandbox check:

- whether a retried delivery carries a fresh `ts` (ShareRepo accepts up to 72 hours old);
- size or key limits on `custom_data` (a claim reference is at most 256 characters);
- whether case differs in the email filter (ShareRepo hands Paddle the address as typed, trimmed);
- which statuses `GET /subscriptions` returns without a `status` filter (the sweep sends none; the purchase rule names every status);
- the exact `error.code` values for a revoked key and a missing permission (ShareRepo acts on the status alone);
- whether `GET /` lists `transaction.read` for a key that has `transaction.write` (ShareRepo requires both names);
- that `GET /notification-settings` returns each `description` exactly as created and includes inactive settings, and that a key with `notification_setting.write` may list them;
- that a destination whose create response was lost appears in the list straight away.

## Product implications

1. **Connection variant for the private launch: API key.** Treat it as the temporary path that `integrations.md` allows. Apply to the Paddle app publisher program in parallel. Record the decision as an ADR when Phase 5 starts. Model `PaddleConnection.credentialKind = api_key | oauth`.
2. **Connect flow:**
   - Validate the key format and derive the environment.
   - Call `GET /` and check that `caller.account` is not null and the environment matches.
   - Check that `caller.permissions` contains the required set and nothing broader is needed. Store `slr_…`.
   - Reject legacy 50-character keys.
   - Ask creators to create a separate key with exactly the listed permissions and the longest expiry they accept. Rotatable is optional.
3. **Connection health:** monitor key expiry, which is unknown to ShareRepo unless the creator tells us. **UNCONFIRMED** whether the API exposes a key's expiry. Subscribe the destination to `api_key.expiring`, `api_key.expired` and `api_key.revoked`. A 403 on any call marks the connection `unauthorized`.
4. **Webhook registration:**
   - Create one destination per connection, with pinned `api_version: 1`, `traffic_source: platform` and `include_sensitive_fields: false`.
   - Subscribe it to subscription, transaction, customer and api_key events.
   - Use a per-connection URL path so the right secret can be chosen before parsing. Store `ntfset_…` plus an encrypted secret.
   - Handle "10 active destinations" as a visible connect error. On disconnect, delete the destination.
5. **Ingestion:**
   - Verify HMAC over the raw bytes, with a timestamp tolerance that we set and test (for example 5 minutes, not Paddle's 5 s SDK default, to allow for clock skew). **Decide:** this is a policy choice.
   - Persist `(connection, event_id)` uniquely along with `occurred_at` and `notification_id`, then ack 200, all within 5 s.
   - Refresh the subscription from the API rather than trusting the snapshot ordering.
6. **Repair:** schedule reconciliation through `GET /subscriptions` per customer or price. Optionally scan `GET /events` from the last checkpoint. Events older than 90 days cannot be fetched, so the subscription list is the source of truth.
7. **Normalisation:**
   - Effective cancellation is `scheduled_change.effective_at` when `action = cancel`, else `canceled_at`.
   - `current_billing_period` disappears when a subscription is paused or canceled, so persist it while it is present.
   - The offer mapping key is `items[].price.id`.
8. **Claim path 1:**
   - Prefer a server-created transaction. ShareRepo calls `POST /transactions` with the offer's price and a signed claim reference in `custom_data`, then redirects to `checkout.url` on the creator's approved domain.
   - This requires the creator's default payment link page to load Paddle.js, which is a creator setup step. It also needs `transaction.write`.
   - A checkout embedded on `sharerepo.org` depends on per-seller domain approval and stays **UNCONFIRMED**.
9. **Claim path 2:** email the address Paddle holds for `ctm_…` through Cloudflare Email Sending (beta) behind an adapter, on Workers Paid.
10. **Rate limits:** Paddle's limit is per IP and Workers egress is shared. Add a per-connection token bucket and a global backoff on 429. Treat a 429 as transient and retry after `Retry-After`.
11. **Tests to add:**
    - signature with multiple `h1` values
    - replayed notification (new `ntf_`, same `evt_`)
    - `subscription.updated` arriving before `subscription.created`
    - `transaction.paid` without `subscription_id`
    - past_due, then exhausted retries ending in either pause or cancel
    - key revoked mid-flight (403)
    - 10-destination limit at connect
    - tampered `custom_data` signature
    - sandbox's 3-attempt retry window during E2E
12. **Questions for Paddle**, if we get publisher-program access:
    - OAuth scopes and token lifetimes
    - whether OAuth tokens can manage notification settings
    - unlisted or private apps
    - sandbox OAuth
    - whether a platform domain can be approved for many sellers
    - secret rotation for destinations
    - per-IP rate limiting for shared-egress platforms
