# Paddle response fixtures

**Hand-built from documentation, not recordings.** They follow the response shapes documented at
developer.paddle.com (Paddle Billing API, `Paddle-Version: 1`, read 2026-10-24), with IDs, names
and emails made up. Replace them with sanitised sandbox recordings when the sandbox check in the
Paddle runbook runs, keeping IDs and emails fictional.

Paddle IDs are a prefix and 26 lower-case letters or digits. Timestamps use Paddle's microsecond
form (`…00.000000Z`) where its examples do. The contract suite (`test/paddle-contract.test.ts`)
builds the same state in `FakePaddle`, so these values and the fake must agree.

| File | Endpoint |
|---|---|
| `api-root.json` | `GET /` with a sandbox API key (api-reference/api-root/get-api-root) |
| `api-root-unauthenticated.json` | `GET /` without valid credentials: `account: null` (the documented example) |
| `prices-page-1.json` | `GET /prices?include=product&status=active,archived&per_page=200`, first page, `has_more: true` |
| `prices-page-2.json` | the last page: an archived one-time price whose product has no description |
| `subscription.json` | `GET /subscriptions/{id}`: active, with a scheduled cancellation and a claim reference in `custom_data` |
| `subscriptions-page-1.json` | `GET /subscriptions?per_page=200`, newest first (`id[DESC]`) |
| `customers.json` | `GET /customers?email=jo%40example.com&per_page=200` |
| `customer.json` | `GET /customers/{id}` |
| `transaction-created.json` | `POST /transactions` → 201, `checkout.url` on the default payment link |
| `notification-setting-created.json` | `POST /notification-settings` → 201 (also served for `GET /notification-settings/{id}`), with a fictional `endpoint_secret_key` |
| `webhook-subscription-updated.json` | a `subscription.updated` delivery body (webhooks/subscriptions/subscription-updated) |
| `error-forbidden.json` | 403 `forbidden` (errors/shared/forbidden) |
| `error-invalid-token.json` | 401/403 `invalid_token` (errors/shared/invalid_token) |
| `error-not-found.json` | 404 `not_found` |
| `error-too-many-requests.json` | 429 `too_many_requests`, served with `Retry-After` |
| `error-destination-limit.json` | 400 `notification_maximum_active_settings_reached` (errors/notifications/…) |
| `error-default-payment-link.json` | 400 `transaction_default_checkout_url_not_set` (errors/transactions/…) |
| `error-invalid-field.json` | 400 `invalid_field`, whose `errors[].message` echoes input (never read) |
| `error-internal.json` | 500 `internal_error` (`api_error`) |
