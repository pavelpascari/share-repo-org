# Threat model — subscriber purchase claim

**Status:** Implemented in Phase 5 as [decision 0012](../decisions/0012-purchase-claims.md). Every threat below has its test scenario, and the E2E journeys in `apps/web/e2e/paddle.spec.ts` cover paths 1 and 2 end to end, including T7's confirmation page. Proposed in Phase 1, which implemented the identity constraints in [Constraints on Phase 1](#constraints-on-phase-1). The [accepted risks](#accepted-risks) stand.

The implementation plan requires this model "before implementing automatic linking". It decides how a Paddle purchase becomes repository access for the right person, and what must never be possible.

## The problem

Three facts are independent ([domain model § Identity linking](../domain-model.md#identity-linking)):

```text
Paddle customer (email E, customer id C)   — who paid
ShareRepo user U                           — who signed in
GitHub external identity G (immutable id)  — who receives access
```

A **claim** links customer C (in workspace W) to user U. Access then goes to U's linked GitHub identity G. Nothing in a payment proves who U is, and nothing in a GitHub login proves who paid.

## Assets

- Repository access bought by a subscriber. Granting it to the wrong person leaks a creator's private source code. This cannot be undone: clones survive revocation ([research](../research/github-personal-accounts.md)).
- The subscriber's paid access. A wrong claim also denies it to the rightful buyer.
- Payment emails and the existence of purchases (personal data).

## Actors

- **Buyer:** paid, may or may not have a ShareRepo account yet, may pay with a different email from their GitHub one.
- **Attacker:** has their own GitHub and ShareRepo accounts, knows or guesses a buyer's email, and can send them links.
- **Creator:** a workspace owner. Can see their own customers but must not be able to move access to an arbitrary GitHub account without leaving an audit trail.
- **Operator:** ShareRepo staff doing manual repair.

## Claim paths

1. **Signed in before checkout (primary).** The signed-in user U starts checkout from ShareRepo. ShareRepo passes a signed, single-use claim reference bound to (W, U, offer) in Paddle `custom_data`. The verified Paddle webhook carrying it links C to U. No email is involved.
2. **Purchase first, claim later (fallback).** The buyer asks to claim with their payment email. ShareRepo sends a one-time link to the email *Paddle has on file for C*. The buyer opens it while signed in and confirms with a POST. Proof is control of the payment mailbox.
3. **Operator or creator link (repair).** A manual link with a required reason, recorded as an audit event. It is never a self-service substitute for 1 or 2.

**Never:** link because a GitHub or ShareRepo email equals the Paddle email, even if GitHub marks the email verified. Domains expire and addresses get recycled, and GitHub email verification is not proof that the person paid.

## Threats and mitigations

| # | Threat | Mitigation | Test scenario |
|---|---|---|---|
| T1 | **Email-match takeover.** An attacker adds the buyer's email to their GitHub account or ShareRepo profile and is linked automatically. | No implicit linking by email anywhere: Better Auth account linking is off, and claims go only through paths 1–3. | `identity/unverified-email-match-grants-nothing` |
| T2 | **Claim token replay or theft.** A link is reused, leaked through logs or referrers, or brute-forced. | At least 128 bits of entropy. Only a SHA-256 hash is stored. Single use, expires after 24 hours, compared in constant time. Tokens and emails are never logged (redaction canaries). The link page sends `Referrer-Policy: no-referrer`. | `claim/token-single-use-and-expiring` |
| T3 | **Link prefetch.** Mail scanners open the link and consume or confirm it. | GET only renders a confirmation page. The claim happens on a POST with a CSRF-protected session. | `claim/get-never-mutates` |
| T4 | **Purchase enumeration.** The attacker learns whether an email bought something. | The response to a claim request is the same whether or not a purchase exists, and so is its timing (the email is sent off the request path). | `claim/request-does-not-reveal-purchases` |
| T5 | **Email bombing or cost abuse.** | Claim requests are rate limited per email (within the workspace), per user and per IP, in D1 rather than isolate memory. A request counts against its limits only if every limit allows it, in one atomic statement, so refused requests use up nothing. The email's limits are per workspace, since anyone can type anyone's email: requests in one workspace never use up its limits in another. Starting a checkout creates a Paddle transaction and stored rows, so it is bounded too: the same user, offer and price within an hour reuses the unused checkout already started, and a new checkout counts against 10 an hour per user and 30 an hour per IP. | `claim/request-rate-limited`, `claim/checkout-start-rate-limited` |
| T6 | **Cross-workspace claim.** A token for workspace A is used to claim a customer in workspace B. | The token is bound to (workspace, customer). The lookup is scoped by workspace, and composite foreign keys enforce it. | `isolation/cross-workspace-mutation-denied` |
| T7 | **Login CSRF / account confusion.** A victim is made to claim while signed in as the attacker, or the reverse. | The confirmation page shows the GitHub account (avatar and login) that will receive access and asks for explicit confirmation. Better Auth's OAuth state and PKCE protect sign-in. | E2E `claim` journey |
| T8 | **Silent re-linking.** After a claim, access is moved to a different GitHub account. | Re-linking needs a new claim or an operator action, is audited, and revokes the previous subject's grant through reconciliation. | `identity/unlink-relink-moves-subject-safely` |
| T9 | **Paddle email change.** The customer's email changes after the claim. | The link is to customer ID C, not to the email. Email is only a snapshot. | Paddle contract tests |
| T10 | **GitHub username reuse.** A username is released and taken by someone else. | Identities are keyed by GitHub's immutable numeric ID. Usernames are snapshots. | `identity/username-change-keeps-identity` |
| T11 | **Forged claim reference in `custom_data`.** | Accepted only from a webhook with a verified signature. The reference is HMAC-signed by ShareRepo, single use, and bound to (W, U, offer). | `webhook/invalid-signature-rejected-before-persist` |
| T12 | **Creator abuse.** A creator links their own customers to arbitrary accounts. | Allowed as repair (path 3) but audited, with the actor, the reason and the previous link. Visible to the operator. A creator can also do it through path 1, see [accepted risks](#accepted-risks). | `audit/every-state-change-has-audit-event` |
| T13 | **Checkout with someone else's email adopts their customer.** The attacker starts a ShareRepo checkout with their own valid reference and enters the victim's email at Paddle's checkout. Paddle puts the new subscription on the victim's customer, which now carries the attacker's reference. Linking that customer would give the attacker every subscription of that customer, including the victim's. This holds whatever the timing: the attacker can leave the checkout open until after the victim's customer is created. | Path 1 links a customer only when every subscription Paddle holds for it carries this same reference. Paddle's list is checked, not trusted: it is requested for every status explicitly, each listed subscription must belong to the customer, and the list must include the subscription that carried the reference and every subscription ShareRepo stores for the customer. A list cut short at Paddle's page cap is refused. Otherwise the refresh records `customer_has_other_purchases`. A customer that ShareRepo recorded before the claim is refused without a Paddle call. If Paddle cannot be read, nothing is linked and the refresh retries. The victim can still claim by email (path 2). | `claim/checkout-cannot-adopt-existing-customer` |

## Accepted risks

- **A buyer gives access away.** A buyer who forwards their claim link or confirms for a friend gives that person access. This is equivalent to sharing a seat and is not a security failure. One subscription seat maps to one subject at a time.
- **A forwarded checkout link.** The Paddle checkout URL from `/buy/<offerId>` carries the claim reference of the user who started it. If that user sends the URL to someone else who pays, the starter receives the access. A friend doing this knowingly is the same as giving access away. The risk is deception: someone may present the link as an ordinary payment page, so the victim pays for access that goes to another account. Mitigations: the reference is consumed by the first customer that presents it, even one already linked (to the starter or to someone else), and expires after 7 days if unused. The payer's receipt comes from the creator's Paddle account. The payer can claim their own customer by email (path 2), which moves the link to them (T8). No cheap check ties the person who pays to the person who started checkout, so the risk is accepted.
- **A customer pre-registered through a checkout.** T13 stops a checkout from adopting a customer with any other purchase. The reverse order remains: an attacker pays through their own checkout with the victim's email before the victim has ever bought, so the new customer is linked to the attacker. The same applies to an existing customer of the seller with no subscription, for example one who only made one-time purchases. If the victim later buys with that email through a direct Paddle link, Paddle reuses the customer, and the new subscription also grants access to the attacker. The attacker must pay, and the victim, who receives the receipts and gets no access, can claim by email (path 2), which moves the link and revokes the attacker's grants. Binding path 1 links to the subscription that carried the reference, rather than to the customer, would close this. That is a larger change to the claim model, deferred.
- **Claim request lockout.** Claim limits stop email bombing (T5), but anyone who knows a buyer's payment email and the workspace can use up that email's limits there (3 an hour, 10 a day) with requests of their own. Each such request counts against the requester's own user and IP limits too, so one account can keep it up at the daily limit. Anyone sharing the buyer's IP address can likewise use up its limit (20 an hour). The buyer then gets no claim link from that workspace until the window ends. Other workspaces are not affected, and refused requests never extend a lockout. Recovery: the buyer waits for the window, or asks the creator, who can link the customer by hand (path 3) after checking the purchase.
- **A creator links through a checkout reference (T12).** A workspace owner can copy a checkout reference minted in their own workspace into the custom data of their customers' subscriptions in the Paddle dashboard. The refresh then links that customer to the user who started the checkout (who need not have finished it). It is recorded as `claim.completed` by the system, not as `customer.linked_manually` with the owner as actor, and carries no reason. The impact stays within that workspace and equals what path 3 lets the owner do, without its audit trail of actor and reason. Mitigation is deferred: binding the claim to its transaction ID would need Paddle to report the transaction a subscription came from.
- **A compromised mailbox or GitHub account.** If an attacker controls the buyer's mailbox or GitHub account, they can claim. ShareRepo cannot do better than the identity providers it relies on.

## Constraints on Phase 1

Phase 1 builds sign-in and identity, not claims. It must still keep paths 1–3 possible and T1 impossible:

1. Better Auth does **not** link accounts implicitly by email. GitHub is the only sign-in provider.
2. `external_identities` is unique on `(provider, external_user_id)` **globally**, so one GitHub account maps to at most one ShareRepo user.
3. The GitHub email may be stored only as a profile snapshot. It is not used for any authorization or linking decision.
4. A username change updates the snapshot of the existing identity and never creates a new identity.
5. Linking and unlinking identities produce audit events.

## Resolved product questions

- **Should checkout require signing in first?** Both paths are supported, with path 1 as the default checkout path from ShareRepo (decision 0012, 2026-10-24).
- **Claim link lifetime:** 24 hours (decision 0012).
