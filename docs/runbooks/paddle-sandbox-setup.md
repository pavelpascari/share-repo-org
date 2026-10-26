# Runbook — Paddle sandbox and the live claim check

These steps are for trying ShareRepo against Paddle's sandbox, and for the live check before Phase 5 merges. Tests and `pnpm test:e2e` never need them: they run against the fake Paddle ([local setup](../local-setup.md#paddle-and-purchase-claims-phase-5)).

Background: [decision 0011](../decisions/0011-paddle-connection-and-tenant-credentials.md) (connection and webhooks), [decision 0012](../decisions/0012-purchase-claims.md) (claims), [research](../research/paddle-billing.md).

## 1. Accounts

1. A **Paddle sandbox account**: sign up at <https://sandbox-vendors.paddle.com/signup>. Sandbox accounts are separate from live ones, with their own keys, catalog and destinations. It needs no business verification.
2. The **GitHub accounts and test repository** from the [GitHub runbook](github-app-setup.md) § 1, with the development GitHub App connected to a workspace (§ 3–5).
3. A **buyer mailbox** you can read, for the email you pay with. A plus address (`you+buyer1@example.com`) gives a fresh Paddle customer each time.

## 2. Expose your local web Worker

Paddle delivers webhooks to `<public origin>/webhooks/paddle/<connectionId>`, and ShareRepo takes the public origin from `BETTER_AUTH_URL`. So for the whole check, ShareRepo must run on a public https URL:

1. Start a tunnel and note its `https://<random>.trycloudflare.com` URL. It changes on every run.

   ```sh
   cloudflared tunnel --url http://localhost:5173
   ```

2. In `apps/web/.dev.vars`, set `BETTER_AUTH_URL=https://<tunnel>`. In `apps/jobs/.dev.vars`, set `PUBLIC_BASE_URL=https://<tunnel>`. Values in `.dev.vars` override the vars in `wrangler.jsonc`.
3. Set your GitHub OAuth App's callback URL to `https://<tunnel>/api/auth/callback/github`, and the GitHub App's setup URL to `https://<tunnel>/github/setup`.
4. Add the commerce secrets to both `.dev.vars` files ([local setup](../local-setup.md#paddle-and-purchase-claims-phase-5)).
5. Start ShareRepo and open it **through the tunnel URL**, never `localhost`: sign-in cookies and form checks are bound to the public origin. If Vite answers "Blocked request. This host is not allowed", start it as `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com pnpm dev`.

A new tunnel URL means a new destination: disconnect Paddle and connect again (§ 6).

## 3. Create the API key

Paddle sandbox → **Developer tools → Authentication → API keys → New API key**.

| Field | Value |
|---|---|
| Name | `ShareRepo dev` |
| Expiry | The default (90 days). Note the date: ShareRepo asks for it. |
| Permissions | **Products: Read**, **Prices: Read**, **Customers: Read**, **Subscriptions: Read**, **Transactions: Read and Write**, **Notification settings: Write**. Optionally **Account: Read**, for the seller's display name. Nothing else. |

The key (`pdl_sdbx_apikey_…`) is shown once. Keep it in your password manager.

## 4. Create a price

Paddle sandbox → **Catalog → Products → New product**, for example "Course access". Add a **recurring** price, monthly, for example 12.00 USD. ShareRepo sells active recurring prices only.

## 5. Set the default payment link

ShareRepo creates each checkout as a Paddle transaction. Paddle opens it on the seller's **default payment link**, a page on the seller's site that loads Paddle.js.

1. **Developer tools → Authentication → Client-side tokens → New client-side token.** Note the `test_…` token.
2. Save this page, with your token, as `checkout/index.html`, and serve it, for example with `python3 -m http.server 8090 --directory checkout`:

   ```html
   <!doctype html>
   <meta charset="utf-8">
   <title>Checkout</title>
   <script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
   <script>
     Paddle.Environment.set("sandbox");
     Paddle.Initialize({ token: "test_…" });
   </script>
   ```

   Paddle.js opens the checkout by itself when the page has `?_ptxn=<transaction>` in its URL. The Billing page shows the same snippet.
3. **Checkout → Checkout settings → Default payment link:** the page's URL, for example `http://localhost:8090/`. Sandbox does not require an approved domain; record it if it refuses a local URL, and use a second tunnel instead.

## 6. Connect

1. In ShareRepo, open the workspace → **Billing**. Paste the key and its expiry date, then **Connect Paddle**. Expect "Paddle is connected and the catalog is imported." and the price under **Catalog**.
2. In Paddle → **Developer tools → Notifications**, a destination named "ShareRepo" points at `https://<tunnel>/webhooks/paddle/<id>`.

## 7. Buy through ShareRepo (path 1)

1. **Offers:** create an offer for the test repository with the Paddle price. Copy its **Checkout link**.
2. In another browser profile, signed out, open the checkout link. Sign in with the **subscriber** GitHub account. The page shows "Access goes to the GitHub account @<subscriber>". Press **Continue to checkout**.
3. Paddle's checkout opens on your payment link page. Pay with the buyer email and Paddle's test card: `4242 4242 4242 4242`, any future expiry date, security code `100`.
4. **Verify the webhooks.** In Paddle → Notifications → the destination's logs, `transaction.completed` and `subscription.created` show `200`. On Billing, **Last event** is set.
5. **Access.** Within seconds, the owner's **Customers** page shows the customer (`ctm_…`) linked to `@<subscriber>`. On **Access**, the row shows "Will invite"; press **Check now** to send the invitation now, or wait for the scheduled check.
6. As the subscriber, accept the invitation on GitHub, then press **Check now**. The row shows "Active". The subscriber's **My access** page lists the repository.

## 8. Claim a purchase made elsewhere (path 2) and cancel

1. In the Paddle dashboard, create a transaction for the price and open its checkout link: it opens on your default payment link, without ShareRepo's reference. Pay as a different buyer email. ShareRepo's **Customers** page shows the new customer as "Not claimed".
2. Sign in to ShareRepo as another GitHub account, open `https://<tunnel>/c/<workspace>/claim` (the **Claim page link** on Offers), and enter that email. The page answers the same whether or not the email paid.

   Claim emails need a mail transport. Locally there is none until the sending domain is onboarded ([deployment](../deployment.md#claim-emails)), so the page says claiming by email is unavailable. Run this step on the deployed dev environment, or check path 2 against the fake (`pnpm test:e2e`), and link the customer by hand from **Customers** here instead (path 3).
3. Open the emailed link while signed in and press **Claim purchase**. Expect "Purchase claimed"; the invitation follows.
4. **Cancel.** In Paddle → **Customers → the subscription → Cancel subscription**, at the end of the billing period. ShareRepo's subscriber keeps access, and My access says "Cancels <date>". Then cancel another subscription **immediately**: after the event, the row shows the access ending, and **Check now** removes the collaborator or the invitation.

## 9. Before merging Phase 5: live sandbox check

Phase 5 is built on the safe assumptions in decisions 0011 and 0012. Several Paddle behaviours are still **UNCONFIRMED** ([research](../research/paddle-billing.md) § 8). Before Phase 5 merges, run §§ 3–8 once and settle each item below. Record the answers in the research doc; if one contradicts the implementation, raise it before merging.

1. **Retried deliveries.** In Notifications, make the destination fail once (stop ShareRepo), then use **Retry** or wait for Paddle's retry. Does the retry's `Paddle-Signature` carry a fresh `ts`? ShareRepo accepts a `ts` up to 72 hours old.
2. **`custom_data` size.** Does a transaction accept a 256-character `sharerepo_claim`, and does it reach the subscription unchanged? Check the subscription in the API (`GET /subscriptions/<id>`).
3. **Page size.** Does `GET /subscriptions?per_page=200` (and prices, customers) return up to 200, without an error?
4. **Email filter case.** Does `GET /customers?email=` match `Buyer@Example.com` to a customer created as `buyer@example.com`? ShareRepo sends the address as typed.
5. **Default statuses.** Which statuses does `GET /subscriptions` return without a `status` filter? Is a canceled subscription included? The daily sweep relies on the answer.
6. **Error codes.** Revoke the key in Paddle, then press **Refresh catalog**: Billing shows "Needs a new API key". Which status and `error.code` did Paddle send? Repeat with a key that lacks `customer.read`. Also note whether `GET /` lists `transaction.read` for a key with only Transactions: Write.
7. **Real fixtures.** Record redacted responses for `GET /`, a price list, a subscription (active, past due, canceled, with a scheduled cancellation), a customer list, a created transaction, a created notification setting and two error bodies. Replace the hand-built fixtures in `packages/integrations/test/fixtures/paddle/` with them, keep the contract suite green, and note any field the client had to change.
8. **Destination list and sweep** (Phase 6 risk fixes). In Notifications, check that ShareRepo's destination is described `ShareRepo workspace <id> created <time>`. Record a redacted `GET /notification-settings` response (it must show the description as created, and include a deactivated destination). Create a destination by hand with that same description and a URL under `/webhooks/paddle/<your connection ID>?v=manual`, wait an hour (or move the description's time back), and run the daily sweep: it must delete that one, audited `paddle.destinations_swept`, and leave a destination of another app alone.
9. **Clean up.** Disconnect Paddle on Billing (every ShareRepo destination disappears from Notifications), and revoke the sandbox key.

Never commit a key, a webhook secret, a customer email or a full payload. Redact IDs you would not publish.
