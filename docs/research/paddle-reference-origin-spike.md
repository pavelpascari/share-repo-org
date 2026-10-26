# Spike — where did a subscription's checkout reference come from?

**Status:** Prepared, not yet run (2026-10-26). Needs the Paddle sandbox, which only the product owner can access. Open item of [decision 0016](../decisions/0016-manual-access-source.md) § Checkout references; plan: [manual access](../plans/manual-access.md).

## Question

Can ShareRepo flag a customer link whose checkout reference (`custom_data.sharerepo_claim`) reached the subscription **outside ShareRepo's own checkout**, by comparing:

- the transaction ShareRepo created for the checkout claim (`checkout_claims.transaction_id`), read with `GET /transactions/{id}`;
- the subscription (`GET /subscriptions/{id}`) and its transactions (`GET /transactions?subscription_id=`);
- the order of events (`GET /events`)?

Decision 0016 says this is not reliable today. The unconfirmed facts are:

1. whether a transaction's `subscription_id` is set by the time `subscription.created` is delivered;
2. what a dashboard edit of a subscription's custom data looks like (an event, no transaction);
3. what `origin` a separate Paddle.js checkout's transaction has.

If ShareRepo can tell "through our checkout" from "some other way", the Customers page can say so. It still cannot say **who** made it arrive.

## The tool

`scripts/spikes/paddle-reference-origin.ts` is read-only. It reads the key from `PADDLE_SANDBOX_API_KEY`, never prints it, and takes the IDs as arguments:

```sh
PADDLE_SANDBOX_API_KEY=pdl_sdbx_apikey_… pnpm spike:paddle-origin --subscription sub_… [--transaction txn_…]
```

It prints JSON with allow-listed, non-personal fields only:

- the subscription: ID, status, customer ID, timestamps, the custom data **keys**;
- the named transaction, and every transaction of the subscription: ID, `status`, `origin`, `subscription_id`, customer ID, timestamps, custom data keys;
- the events of the latest page that concern the subscription or its transactions, oldest first: event ID, type, time, `transaction_id`, `origin`.

A claim reference is printed only as `referenceDigest`, 12 hex characters of its SHA-256, so two can be compared without printing either. Emails, names, addresses and custom data values are never printed (`scripts/test/paddle-reference-origin.test.ts`). `eventsTruncated: true` means the latest events page was full: run it soon after the scenario, or read older events in the dashboard.

## Setup

Follow the [sandbox runbook](../runbooks/paddle-sandbox-setup.md) § 1–7: a sandbox account, an API key with **Transactions: Read**, a recurring price, the default payment link page, and ShareRepo connected through a tunnel. For this spike the key also needs **Notifications: Read** (`notification.read`), for `GET /events`.

Find the IDs in the sandbox dashboard (**Customers → Subscriptions**, **Transactions**). The checkout's transaction is the `_ptxn` parameter of the URL ShareRepo redirected to, or the `transaction_id` of the checkout claim in the local D1:

```sh
pnpm --filter @sharerepo/db exec wrangler d1 execute DB --local -c ../../apps/web/wrangler.jsonc \
  --command "SELECT id, transaction_id, consumed_by_customer_id FROM checkout_claims ORDER BY created_at DESC LIMIT 5"
```

## Scenarios

### (a) A normal ShareRepo checkout

1. Signed in as a buyer, open `/buy/<offerId>`, choose the price and pay with a test card (runbook § 7).
2. Note the subscription (`sub_A`) and the transaction in the checkout URL (`txn_A`).
3. Run:

   ```sh
   PADDLE_SANDBOX_API_KEY=pdl_sdbx_apikey_… pnpm spike:paddle-origin --subscription sub_A --transaction txn_A
   ```

4. **Observe:** is `checkoutTransaction.subscriptionId` equal to `sub_A`? Note `checkoutTransaction.origin`. Is `txn_A` the first of `subscriptionTransactions`? Do the subscription's and the transaction's `referenceDigest` match? In `events`, does `transaction.completed` (with `subscription_id`) come before `subscription.created`, or at the same time?
5. Run it again right after paying, within seconds, to see whether `subscription_id` is already set when `subscription.created` arrives.

### (b) A reference pasted into another subscription in the dashboard

1. Buy the same price through a **direct Paddle link** (not `/buy`), with another email. This creates `sub_B` with its own transaction and no reference.
2. In the sandbox dashboard, open `sub_B` and set custom data `{"sharerepo_claim": "<the reference from sub_A>"}`. (The reference is in `sub_A`'s custom data in the dashboard. Don't paste it anywhere else.)
3. Run:

   ```sh
   PADDLE_SANDBOX_API_KEY=pdl_sdbx_apikey_… pnpm spike:paddle-origin --subscription sub_B --transaction txn_A
   ```

4. **Observe:** `checkoutTransaction.subscriptionId` should be `sub_A`, not `sub_B`. Does `sub_B`'s first transaction have the reference (`referenceDigest`), or not? Is there a `subscription.updated` event after `subscription.created` carrying the digest?

### (c) A reference passed through a separate Paddle.js checkout

1. On the default payment link page, open a checkout in the browser console with the reference from step (a):

   ```js
   Paddle.Checkout.open({ items: [{ priceId: "pri_…", quantity: 1 }], customData: { sharerepo_claim: "<reference>" } });
   ```

2. Pay with a third email. Note `sub_C`.
3. Run:

   ```sh
   PADDLE_SANDBOX_API_KEY=pdl_sdbx_apikey_… pnpm spike:paddle-origin --subscription sub_C --transaction txn_A
   ```

4. **Observe:** `sub_C`'s first transaction: its `origin`, and whether it carries the reference from creation. Is `checkoutTransaction.subscriptionId` still `sub_A`?

## Decision rule

- **Detectable as "outside ShareRepo's checkout" if**, in every run of (a) (including one right after paying), `checkoutTransaction.subscriptionId` equals the subscription by the time ShareRepo's refresh reads it, and in (b) and (c) it does not. ShareRepo would then compare the claim's transaction with the subscription before linking, and record the link with a distinguishing flag on the Customers page.
- **Attributable to the creator only if** (b) and (c) can be told apart too. For example, (b)'s first transaction lacks the reference and a later `subscription.updated` adds it, while (c)'s first transaction has it with origin `web`. Even then the flag would read "added after purchase (seller-side change)", not name a person.
- **Not detectable if** `subscriptionId` is missing in some (a) runs at refresh time (a race), or (b) and (a) look the same. Then the current design stands: visible link path and removal by hand.

## Results

Fill in after running. Paste the relevant JSON fields, never keys or references.

| Scenario | Run at | `checkoutTransaction.subscriptionId` | First sub transaction `origin` | Reference on first transaction? | Event order (types) | Notes |
|---|---|---|---|---|---|---|
| (a) right after paying | | | | | | |
| (a) a minute later | | | | | | |
| (b) dashboard paste | | | | | | |
| (c) Paddle.js checkout | | | | | | |

**Conclusion:** _pending_.
