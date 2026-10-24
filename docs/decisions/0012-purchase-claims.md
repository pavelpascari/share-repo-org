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
  - ShareRepo then creates a transaction (`POST /transactions`) for that price, with `custom_data.sharerepo_claim` set to the claim reference. It redirects the buyer to the transaction's `checkout.url`.
  - If the seller has no default payment link, the page names the setup step instead.
- **The claim reference** is `v1.<checkoutClaimId>.<mac>`. The MAC is HMAC-SHA256, keyed with the ShareRepo secret `CLAIM_SIGNING_KEY`, over `v1|workspaceId|checkoutClaimId|userId|offerId`. Only the reference travels through Paddle.
- **Linking.**
  - The Paddle adapter reports the subscription's `custom_data.sharerepo_claim`. The refresh verifies the MAC in constant time and loads the checkout claim within the subscription's workspace.
  - The reference must not have expired, and must not be consumed by another customer. A buyer can rewrite custom data in the browser (T11), so an unverified, unknown, expired, or other-workspace reference is ignored and audited as `claim.rejected`.
  - A verified reference links the customer to the user's subject, creating the subject from the user's GitHub identity. The link is made only if the customer is unlinked or already linked to that subject.
  - The first link consumes the checkout claim for that customer. Renewals carry the same reference and stay valid.
  - A different customer presenting a consumed reference is not linked.
- **A customer already linked to another subject** is never re-linked by path 1 (T8). The refresh records `claim.conflict`, and the buyer can use path 2 or ask the creator.

### Path 2: purchase first, claim later (fallback)

- **The request.** Each workspace has `/c/<slug>/claim`. A signed-in buyer enters the email they paid with.
  - The response is the same, and returns in constant time, whether or not a purchase exists (T4).
  - The request is rate limited in D1 (T5):
    - per email hash: 3 an hour and 10 a day;
    - per user: 5 an hour;
    - per IP: 20 an hour.
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
