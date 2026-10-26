# 0012 — Purchase claims: checkout reference, emailed claim link, audited manual link

**Status:** Accepted (both claim paths are a product decision, 2026-10-24)

## Context

A Paddle purchase says who paid, not who should receive repository access. The [purchase-claim threat model](../security/purchase-claim-threat-model.md) defines three claim paths and the threats they must resist. It left two questions open:

- Should checkout require signing in first? The answer: support both paths, with signing in first as the default.
- How long should a claim link live? The answer: 24 hours.

The research ([paddle-billing.md](../research/paddle-billing.md) § 5) settles how checkout can work. A live checkout only opens on a domain Paddle approved for that seller. `POST /transactions` accepts `custom_data` and returns a `checkout.url` on the seller's default payment link.

## Decision

A **claim** links a Paddle customer (`ctm_…`) in a workspace to a ShareRepo user's GitHub identity, through a workspace **subject**. Access then follows the existing entitlement policy and reconciliation. Nothing links by email match (threat T1).

### Path 1: signed in before checkout (default)

- **Starting a checkout.** Each Paddle offer has a public checkout page, `/buy/<offerId>`.
  - The buyer signs in with GitHub. The page shows the offer and the GitHub account that will receive access, and lists the offer's prices.
  - A same-origin POST creates a **checkout claim**. The checkout claim is a row bound to the workspace, user, offer and price, and it expires after 7 days.
  - Starting the same offer and price again within an hour, while that checkout is unused, sends the buyer back to its stored checkout URL and creates nothing. A new checkout is rate limited in D1: 10 an hour per user and 30 an hour per IP. Beyond them the page says "Too many checkout attempts; try again later." without calling Paddle.
  - ShareRepo then creates a transaction (`POST /transactions`) for that price, with `custom_data.sharerepo_claim` set to the claim reference. It redirects the buyer to the transaction's `checkout.url`.
  - If the seller has no default payment link, the page names the setup step instead.
- **The claim reference** is `v1.<checkoutClaimId>.<mac>`. The MAC is HMAC-SHA256, keyed with the ShareRepo secret `CLAIM_SIGNING_KEY`, over `v1|workspaceId|checkoutClaimId|userId|offerId`. Only the reference travels through Paddle.
- **Linking.**
  - The Paddle adapter reports the subscription's `custom_data.sharerepo_claim`. The refresh verifies the MAC in constant time and loads the checkout claim within the subscription's workspace.
  - The reference must not have expired, and must not be consumed by another customer. A buyer can rewrite custom data in the browser (T11), so an unverified, unknown, expired, or other-workspace reference is ignored and audited as `claim.rejected`.
  - **The link follows the purchase, not the customer.** At checkout the buyer can enter any email, and Paddle then puts the new subscription on the existing customer with that email. Linking that customer would hand all of its subscriptions, including those of the email's owner, to whoever started the checkout (threat T13). A customer is therefore linked only when every subscription Paddle holds for it, in any status, carries this same reference. Otherwise the refresh records `claim.rejected` with reason `customer_has_other_purchases`.
    - A customer that ShareRepo recorded before the claim was created is refused without asking Paddle. ShareRepo records a customer with its first subscription, and that subscription cannot carry a reference that did not exist yet.
    - Otherwise the refresh lists the customer's subscriptions (`GET /subscriptions?customer_id=&status=<every status>`) through the workspace's active connection. A list cut short at the page cap is refused, and so is an empty list.
    - The list is checked, not trusted. Each listed subscription must belong to the customer, and the list must include the subscription that carried the reference and every subscription ShareRepo stores for the customer. Otherwise the refresh records `customer_has_other_purchases`.
    - The rule depends on purchases, not on time. A check on creation time fails when the attacker leaves a checkout open, and the victim's customer is created and bought for after the claim but before the attacker pays. Paddle's customer creation time is therefore not consulted.
    - If Paddle cannot be read, nothing is linked or rejected. This covers no active connection, a refused key (which marks the connection unauthorized) and a transient failure. The refresh fails and is retried. The reference stays on the subscription, and every refresh evaluates an unlinked customer again.
    - Once linked, a customer stays linked. Renewals, and a later subscription carrying the same reference, need no new check.
    - A returning buyer who pays with the email of an unclaimed customer of theirs is refused too. They claim it through path 2.
  - A verified reference links the customer to the user's subject, creating the subject from the user's GitHub identity. The link is made only if the customer is unlinked or already linked to that subject.
  - The first link consumes the checkout claim for that customer. Renewals carry the same reference and stay valid.
  - A customer that is already linked, to the buyer's subject or to another (a conflict), still consumes a claim it presents first. It is audited as `claim.completed` or `claim.conflict`. A leaked copy of the reference then cannot link another customer to the buyer.
  - A different customer presenting a consumed reference is not linked.
- **A customer already linked to another subject** is never re-linked by path 1 (T8). The refresh records `claim.conflict`, and the buyer can use path 2 or ask the creator.

- **A suspended workspace** links nothing through path 1. The refresh still records the subscription's facts there. Once the workspace is active again, a later refresh links if the claim is still usable.

### Path 2: purchase first, claim later (fallback)

- **The request.** Each workspace has `/c/<slug>/claim`. A signed-in buyer enters the email they paid with.
  - The response is the same, and returns in constant time, whether or not a purchase exists (T4).
  - The request is rate limited in D1 (T5):
    - per email hash, within the workspace: 3 an hour and 10 a day;
    - per user: 5 an hour;
    - per IP: 20 an hour.
  - A request counts against these limits only when all of them allow it, in one atomic statement. A refused request uses up nothing.
  - The email is stored only as an envelope (decision 0011) on a **claim request** row. A job, `send_claim_email`, handles the rest off the request path.
- **The job.**
  - It looks up the workspace's Paddle customers with that email (`GET /customers?email=`). It considers only customers ShareRepo already knows from webhooks.
  - For each, it issues a **claim token**:
    - 256 random bits, of which only the SHA-256 is stored;
    - single use;
    - expires after 24 hours;
    - bound to the workspace and the customer.
  - It emails the link to the address Paddle holds for that customer.
  - It erases the email envelope whether or not a match exists.
- **The link.** `GET /claim/<token>` only renders a confirmation page (T3), with `Referrer-Policy: no-referrer`.
  - While the token's workspace is suspended, the link behaves like an unknown one: the page names no workspace and nothing is recorded. A request whose workspace is suspended before the job runs sends no link.
  - The page shows the workspace, the offers covered, and the GitHub account (avatar and login) that will receive access (T7). It requires sign-in.
  - A same-origin POST consumes the token and links the customer to the signed-in user's subject.
- **Re-linking.** If the customer was linked to another subject, the link moves.
  - The change is audited as `customer.relinked`, with the previous subject.
  - The previous subject's entitlements end through the normal recompute, and reconciliation revokes its managed grants (`identity/unlink-relink-moves-subject-safely`).
  - Proof of control of the payment mailbox outranks an earlier link.
- **Email** is sent through a mail port. Deployed environments use Cloudflare Email Service (the `send_email` binding, in public beta). E2E captures mail in the fake provider. Where no mail transport is configured, the claim page says claiming by email is unavailable.

### Path 3: manual link (repair)

- A workspace owner can link a customer to a GitHub account from the Customers page.
- The account is entered by login and resolved to its immutable ID through the workspace's GitHub connection. A reason is required.
- The link is audited as `customer.linked_manually`, with the actor, the reason and the previous subject. It can move an existing link.

### Storage and privacy

- ShareRepo never stores customer emails, except the short-lived envelope on a claim request.
- The Customers page shows the Paddle customer ID, the linked GitHub login and the subscription states.
- Tokens, references, emails and keys never appear in logs or audit details. Audit records carry IDs.

## Consequences

- A creator sells by sharing `/buy/<offerId>`. Paddle checkout links shared directly also work, through path 2.
- Path 1 needs `transaction.write` on the key, and a default payment link page on the creator's approved domain that loads Paddle.js. The billing page gives a snippet.
- Path 2 depends on a beta email service and on Workers Paid. It sits behind an adapter so the provider can change.
- Hosting checkout on `sharerepo.org` would need Paddle to approve that domain for each seller, which is unconfirmed. It is not part of v1.

## Amendment — rotating `CLAIM_SIGNING_KEY` (Phase 6 T5)

`CLAIM_SIGNING_KEY` becomes a keyring (`{"current","keys"}`); the Phase 5 plain-text key still works as a keyring of one. The current key signs new checkout references and computes the email and IP hashes. Rotation must not break either use of the key:

- **References** carry no key ID. Verification tries every listed key, always all of them, each with WebCrypto's constant-time HMAC verify, so the time taken does not say which key matched. A checkout claim the customer has already used is not verified again on its renewals: its reference was verified when the claim was used. So once a retired key is removed, renewals of customers it linked stay silent instead of recording `claim.rejected`.
- **Email and IP hashes** are only rate-limit bucket names: `claim_requests.email_hash` is stored but never looked up. A new key would give every email and IP fresh counters, so a rotation would reset the limits once. Instead, each request computes its hashes under every listed key. It counts under the current key, and the counters under the other keys, in the same window, add to the same limit (`RateLimitBucket.retired`, applied atomically by `takeRateLimits`). Rotating cannot double a limit.
- **Rejected alternative:** waiting out the claim windows before switching keys. It still resets the counters at the switch, and it needs a two-step deploy with a timed wait in between. Counting across keys costs one HMAC per listed key per request.

The runbook ([secret-rotation.md](../runbooks/secret-rotation.md) § 2) keeps a retired key listed for at least 8 days (the 7-day checkout claim lifetime, plus the 1-day rate-limit window), then removes it. Removing a key ends its acceptance (threat O16).
