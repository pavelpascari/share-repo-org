import * as repo from "@sharerepo/db";
import {
  type AuditDetails,
  type AuditEvent,
  type AuditEventInput,
  auditEvent,
  CHECKOUT_CLAIM_LIFETIME_MS,
  CHECKOUT_REUSE_WINDOW_MS,
  CLAIM_TOKEN_LIFETIME_MS,
  ClaimRejectionReason,
  type CommercialSource,
  CustomerLinkDecision,
  checkoutClaimUsable,
  checkoutRateLimitBuckets,
  claimRateLimitBuckets,
  claimTokenUsable,
  customerKnownBeforeClaim,
  decideCustomerLink,
  type EMAIL_REJECTION_REASONS,
  type KeyedHash,
  LinkPath,
  OutboxKind,
  parseGitHubLogin,
  parseWorkspaceSlug,
  purchasesOnlyThroughClaim,
} from "@sharerepo/domain";
import {
  CLAIM_REFERENCE_KEY,
  type GitHubAppPort,
  type MailPort,
  PaddleApiError,
  PaddleErrorCode,
} from "@sharerepo/integrations";
import {
  ConflictError,
  claimSigningKeysOf,
  envelopeAad,
  hashClaimEmail,
  hashClaimToken,
  hashIp,
  isClaimToken,
  NotFoundError,
  newClaimToken,
  openSecret,
  parseClaimReference,
  sealSecret,
  signClaimReference,
  verifyClaimReference,
} from "@sharerepo/platform";
import { z } from "zod";
import {
  asAuditActor,
  atOneInstant,
  type ServiceContext,
  type UserActor,
  type WorkspaceAuditAction,
} from "./context.ts";
import {
  type CheckoutClaimSupport,
  type ClaimRequestRef,
  encodeClaimRequestKey,
} from "./entitlement-source.ts";
import { resolveGitHubAccount } from "./github-accounts.ts";
import {
  activePaddleConnection,
  type CatalogPrice,
  type CommerceDeps,
  catalogPrice,
  withPaddle,
} from "./paddle.ts";
import { type ReportedClaim, refreshOutboxRow, subjectFor } from "./subscriptions.ts";
import { openWorkspace } from "./workspaces.ts";

// Purchase claims (decision 0012, threat model). A claim links a Paddle customer to a ShareRepo
// user's GitHub account through the workspace's subject; access then follows the entitlement
// policy. Nothing ever links by email match (threat T1): only a verified checkout reference
// (path 1), proof of the payment mailbox (path 2), or an owner's audited manual link (path 3).
// Audit details carry IDs only: never an email, token, reference or key.

const SYSTEM = { type: "system", id: null } as const;

type EmailRejectionReason = (typeof EMAIL_REJECTION_REASONS)[number];

/** A workspace-scoped audit event (the generic form `auditEvent` cannot type for a generic A). */
function workspaceEvent<A extends WorkspaceAuditAction>(
  ctx: ServiceContext,
  action: A,
  input: {
    workspaceId: string;
    actor: AuditEvent["actor"];
    targetId: string;
    details: AuditDetails<A>;
    reason?: string;
  },
): AuditEvent {
  return auditEvent(action, input as unknown as AuditEventInput<A>, ctx);
}

/**
 * A keyed hash under the current claim signing key, and under each other key still listed. Rate
 * limits count under the current key and add the others' counts, so rotating `CLAIM_SIGNING_KEY`
 * does not reset them (decision 0012 amendment).
 */
async function keyedHash(
  deps: Pick<CommerceDeps, "claimSigningKeys">,
  hash: (key: Uint8Array) => Promise<string>,
): Promise<KeyedHash> {
  const { current, retired } = claimSigningKeysOf(deps.claimSigningKeys);
  return { current: await hash(current), retired: await Promise.all(retired.map(hash)) };
}

/** Queues a refresh of each subscription a link moves, so its entitlements follow the link. */
const refreshRows =
  (ctx: ServiceContext, workspaceId: string) =>
  (subscription: { source: CommercialSource; externalSubscriptionId: string }) =>
    refreshOutboxRow(ctx, { workspaceId, ...subscription });

/** The claimant's GitHub identity, and their subject in the workspace if it has one. */
interface Claimant {
  readonly identity: repo.ExternalIdentity;
  readonly subject: repo.Subject | null;
  /** The subject's ID, or the ID a new subject will take. */
  readonly subjectId: string;
}

async function claimantIn(
  ctx: ServiceContext,
  workspaceId: string,
  userId: string,
): Promise<Claimant> {
  // Every user signs in with GitHub (decision 0006), so the identity exists.
  const identity = (await repo.findExternalIdentityForUser(ctx.db, {
    userId,
    provider: "github",
  })) as repo.ExternalIdentity;
  const subject = await repo.findSubjectByExternalId(ctx.db, {
    workspaceId,
    provider: "github",
    externalSubjectId: identity.externalUserId,
  });
  return { identity, subject, subjectId: subject?.id ?? ctx.ids.next() };
}

/** The claimant's subject, created (and audited) when the workspace has none yet. */
async function claimantSubjectId(
  ctx: ServiceContext,
  workspaceId: string,
  claimant: Claimant,
  actor: AuditEvent["actor"],
): Promise<string> {
  if (claimant.subject !== null) return claimant.subject.id;
  const { identity, subjectId } = claimant;
  const { subject } = await repo.findOrCreateSubjectForIdentity(
    ctx.db,
    { workspaceId, identity, subjectId, now: ctx.clock.now() },
    [
      workspaceEvent(ctx, "subject.created", {
        workspaceId,
        actor,
        targetId: subjectId,
        details: {
          provider: "github",
          externalSubjectId: identity.externalUserId,
          login: identity.usernameSnapshot,
        },
      }),
    ],
  );
  return subject.id;
}

// Path 1: the checkout reference ------------------------------------------------------------

/**
 * Applies the checkout reference a refresh found on a subscription (decision 0012, path 1). The
 * reference is untrusted (threat T11): it must parse, name a checkout claim of this workspace,
 * carry that claim's MAC (workspace, claim, user, offer), and the claim must be usable for this
 * customer. Then an unlinked customer is linked to the buyer's subject, consuming the claim in the
 * same batch, and audited `claim.completed`; anything else is audited `claim.rejected`. A customer
 * linked to another subject is never moved (threat T8): `claim.conflict`. A customer already
 * linked, to the buyer or to someone else, still uses up a claim it presents first (audited
 * `claim.completed` or `claim.conflict`), so the reference cannot link another customer later.
 *
 * The link follows the purchase, not the customer: a buyer can enter anyone's email at checkout,
 * and Paddle then puts the subscription on that person's customer. So a customer is linked only
 * when every subscription the source holds for it carries this same reference; otherwise
 * `customer_has_other_purchases`. The source's list is checked, not trusted: it must hold only
 * this customer's subscriptions, including the one that carried the reference and every one
 * ShareRepo stores for the customer. A customer ShareRepo recorded before the claim fails that
 * rule and is refused without asking the source. When the source cannot be read, nothing is linked or
 * rejected and the error propagates, so the refresh is retried; the reference stays on the
 * subscription and an unlinked customer is evaluated again by every refresh.
 *
 * Nothing is linked, or recorded, while the workspace is suspended: the refresh still records
 * commercial facts there, but a link is a change made for a buyer. A refresh after reactivation
 * links, while the claim is usable.
 *
 * A linked customer is looked at again only when the refresh applied newer facts, so renewals
 * stay silent and a conflict is recorded once per change rather than once per refresh.
 */
export async function linkCheckoutReference(
  context: ServiceContext,
  workspaceId: string,
  reported: ReportedClaim,
  source: CheckoutClaimSupport,
): Promise<void> {
  const { customer, reference, newer } = reported;
  if (customer.subjectId !== null && !newer) return;
  const ctx = atOneInstant(context);
  // Workspaces are never deleted, so it exists.
  const workspace = (await repo.getWorkspace(ctx.db, workspaceId)) as repo.Workspace;
  if (workspace.status !== "active") return;
  const now = ctx.clock.now();
  const record = (event: AuditEvent) => repo.appendAuditEvents(ctx.db, [event]);
  const reject = (reason: ClaimRejectionReason, claimId: string | null) =>
    record(
      workspaceEvent(ctx, "claim.rejected", {
        workspaceId,
        actor: SYSTEM,
        targetId: customer.id,
        details: { path: LinkPath.Checkout, claimId, reason },
      }),
    );

  const parsed = parseClaimReference(reference);
  if (!parsed.ok) return reject(ClaimRejectionReason.SignatureInvalid, null);
  // Looked up in the subscription's workspace only: another workspace's claim is unknown here.
  const claim = await repo.getCheckoutClaim(ctx.db, { workspaceId, id: parsed.checkoutClaimId });
  if (claim === null) return reject(ClaimRejectionReason.UnknownClaim, null);
  // A claim this customer already used was verified when it was used: its renewals need no MAC,
  // so they stay silent once the key that signed the reference is retired (secret rotation).
  const usedByCustomer = claim.consumedByCustomerId === customer.id;
  const verified =
    usedByCustomer ||
    (await verifyClaimReference({
      keys: source.signingKeys,
      reference,
      workspaceId,
      userId: claim.userId,
      offerId: claim.offerId,
    }));
  if (!verified) return reject(ClaimRejectionReason.SignatureInvalid, null);
  const usable = checkoutClaimUsable(claim, { now, customerId: customer.id });
  if (!usable.usable) return reject(usable.reason, claim.id);

  const claimant = await claimantIn(ctx, workspaceId, claim.userId);
  const decision = decideCustomerLink({
    currentSubjectId: customer.subjectId,
    proposedSubjectId: claimant.subjectId,
    path: LinkPath.Checkout,
  });
  // The customer used this claim before and has been unlinked since, by an owner (decision 0016)
  // or an account deletion (decision 0015): a used claim never links again, so nothing is asked
  // of Paddle. An emailed claim or a manual link can link it.
  if (decision === CustomerLinkDecision.Link && usable.renewal) return;
  // A customer that is already linked uses up the claim it first presents, as a link would: a
  // leaked copy of the reference must never link another customer to the claimant later.
  const useUp = (event: AuditEvent) =>
    repo.consumeCheckoutClaim(ctx.db, { workspaceId, id: claim.id, customerId: customer.id, now }, [
      event,
    ]);
  if (decision === CustomerLinkDecision.Noop) {
    if (usable.renewal) return;
    await useUp(
      workspaceEvent(ctx, "claim.completed", {
        workspaceId,
        actor: SYSTEM,
        targetId: customer.id,
        details: {
          path: LinkPath.Checkout,
          claimId: claim.id,
          userId: claim.userId,
          subjectId: claimant.subjectId,
        },
      }),
    );
    return;
  }
  if (decision === CustomerLinkDecision.Conflict) {
    const conflict = workspaceEvent(ctx, "claim.conflict", {
      workspaceId,
      actor: SYSTEM,
      targetId: customer.id,
      details: {
        path: LinkPath.Checkout,
        claimId: claim.id,
        subjectId: customer.subjectId as string,
        userId: claim.userId,
      },
    });
    // Recorded with the claim's first use, or on its own when this customer used it before (a
    // renewal, or a concurrent refresh of the same customer).
    if (!usable.renewal) {
      const consumed = await useUp(conflict);
      if (consumed.ok && consumed.first) return;
    }
    return record(conflict);
  }
  // Only a customer whose every purchase came through this checkout: first what ShareRepo
  // already knew, then every subscription the source holds for it.
  const otherPurchases = () => reject(ClaimRejectionReason.CustomerHasOtherPurchases, claim.id);
  if (
    customerKnownBeforeClaim({
      claimCreatedAt: claim.createdAt,
      customerRecordedAt: customer.createdAt,
    })
  ) {
    return otherPurchases();
  }
  const [purchases, storedSubscriptionIds] = await Promise.all([
    source.customerPurchases({ workspaceId, externalCustomerId: customer.externalCustomerId }),
    repo.listCustomerSubscriptionIds(ctx.db, { workspaceId, customerId: customer.id }),
  ]);
  const qualifies = purchasesOnlyThroughClaim({
    reference,
    externalCustomerId: customer.externalCustomerId,
    externalSubscriptionId: reported.externalSubscriptionId,
    storedSubscriptionIds,
    purchases,
  });
  if (!qualifies) return otherPurchases();
  const subjectId = await claimantSubjectId(ctx, workspaceId, claimant, SYSTEM);
  // Guarded on the customer still being unlinked and the claim still unconsumed; a concurrent
  // link wins, and the next refresh looks again while the customer stays unlinked.
  await repo.applyCustomerLink(
    ctx.db,
    {
      workspaceId,
      customerId: customer.id,
      expectedSubjectId: null,
      subjectId,
      now,
      makeRefreshRow: refreshRows(ctx, workspaceId),
      consume: { kind: "checkout_claim", id: claim.id },
    },
    [
      workspaceEvent(ctx, "claim.completed", {
        workspaceId,
        actor: SYSTEM,
        targetId: customer.id,
        details: { path: LinkPath.Checkout, claimId: claim.id, userId: claim.userId, subjectId },
      }),
    ],
  );
}

// Path 1: checkout --------------------------------------------------------------------------

interface CheckoutOffer {
  readonly offer: repo.OfferWithConfig;
  readonly workspace: repo.Workspace;
  /** The offer's Paddle prices that can be bought now: active and recurring. */
  readonly prices: readonly repo.PaddlePrice[];
  readonly connection: repo.PaddleConnection | null;
}

/** An active offer of an active workspace, with what checkout needs; null when there is none. */
async function checkoutOffer(ctx: ServiceContext, offerId: string): Promise<CheckoutOffer | null> {
  const workspaceId = await repo.findOfferWorkspaceId(ctx.db, offerId);
  if (workspaceId === null) return null;
  // Offers and workspaces are never deleted, so both exist.
  const [offer, workspace, prices, connection] = await Promise.all([
    repo.getOffer(ctx.db, { workspaceId, offerId }) as Promise<repo.OfferWithConfig>,
    repo.getWorkspace(ctx.db, workspaceId) as Promise<repo.Workspace>,
    repo.listPaddlePrices(ctx.db, { workspaceId, activeRecurringOnly: true }),
    activePaddleConnection(ctx, workspaceId),
  ]);
  if (offer.status !== "active" || workspace.status !== "active") return null;
  const items = new Set(
    offer.items.filter((item) => item.source === "paddle").map((item) => item.externalItemId),
  );
  return {
    offer,
    workspace,
    prices: prices.filter((price) => items.has(price.priceId)),
    connection,
  };
}

/** The buyer's GitHub account as the page shows it (threat T7). */
export interface ClaimantAccount {
  readonly login: string;
  readonly avatarUrl: string | null;
}

const accountOf = (identity: repo.ExternalIdentity): ClaimantAccount => ({
  login: identity.usernameSnapshot,
  avatarUrl: identity.avatarUrlSnapshot,
});

export interface CheckoutView {
  readonly offer: { readonly id: string; readonly name: string };
  readonly workspace: { readonly slug: string; readonly name: string };
  /** The repositories the offer gives access to, by name. */
  readonly repositories: readonly string[];
  readonly prices: readonly CatalogPrice[];
  /** The GitHub account that will receive access. */
  readonly account: ClaimantAccount;
}

export type CheckoutViewResult =
  | { readonly ok: true; readonly view: CheckoutView }
  /**
   * `not_found`: no such active offer; `unavailable`: its workspace has no active Paddle
   * connection, or the offer has no price that can be bought now.
   */
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

/** The checkout page (`/buy/:offerId`) for a signed-in buyer. Reads only. */
export async function getCheckoutView(
  context: ServiceContext,
  input: { readonly offerId: string; readonly user: UserActor },
): Promise<CheckoutViewResult> {
  const found = await checkoutOffer(context, input.offerId);
  if (found === null) return { ok: false, reason: "not_found" };
  if (found.connection === null || found.prices.length === 0) {
    return { ok: false, reason: "unavailable" };
  }
  const { offer, workspace } = found;
  const [resources, identity] = await Promise.all([
    repo.listResourcesForWorkspace(context.db, workspace.id),
    repo.findExternalIdentityForUser(context.db, { userId: input.user.userId, provider: "github" }),
  ]);
  const names = new Map(resources.map((resource) => [resource.id, resource.nameSnapshot]));
  return {
    ok: true,
    view: {
      offer: { id: offer.id, name: offer.name },
      workspace: { slug: workspace.slug, name: workspace.name },
      repositories: offer.accesses.map((access) => names.get(access.resourceId) as string),
      prices: found.prices.map(catalogPrice),
      account: accountOf(identity as repo.ExternalIdentity),
    },
  };
}

export type StartCheckoutResult =
  | {
      readonly ok: true;
      /** Paddle's checkout on the seller's default payment link: redirect the buyer there. */
      readonly checkoutUrl: string;
      readonly checkoutClaimId: string;
    }
  | {
      readonly ok: false;
      /**
       * `not_found`, `unavailable`: as for the page; `price_invalid`: not a price of this offer
       * that can be bought now; `no_default_payment_link`: the seller has not set the default
       * payment link Paddle needs (the page names the setup step); `rate_limited`: the buyer, or
       * their IP address, started too many new checkouts this hour.
       */
      readonly reason:
        | "not_found"
        | "unavailable"
        | "price_invalid"
        | "no_default_payment_link"
        | "rate_limited";
    };

/**
 * Starts checkout for a signed-in buyer (decision 0012, path 1): a Paddle transaction for the
 * price, carrying the signed reference of a new checkout claim bound to the workspace, the buyer
 * and the offer (7 days), audited `checkout.started`. Nothing is stored when Paddle refuses.
 *
 * Each new checkout costs a Paddle transaction and stored rows, so it is bounded: a buyer who
 * starts the same offer and price again within an hour, while that checkout is unused, is sent
 * back to it (nothing is written); a new one counts against per-user and per-IP limits in D1,
 * and is `rate_limited` beyond them without calling Paddle.
 */
export async function startCheckout(
  context: ServiceContext,
  input: {
    readonly offerId: string;
    readonly priceId: string;
    readonly user: UserActor;
    readonly ip: string;
  },
  deps: CommerceDeps,
): Promise<StartCheckoutResult> {
  const ctx = atOneInstant(context);
  const found = await checkoutOffer(ctx, input.offerId);
  if (found === null) return { ok: false, reason: "not_found" };
  const { offer, connection } = found;
  if (connection === null) return { ok: false, reason: "unavailable" };
  if (!found.prices.some((price) => price.priceId === input.priceId)) {
    return { ok: false, reason: "price_invalid" };
  }
  const workspaceId = offer.workspaceId;
  const { userId } = input.user;
  const now = ctx.clock.now();
  // Reusing a checkout whose payment completed moments ago (its webhook not yet processed)
  // sends the buyer to Paddle's page for a paid transaction; the window is seconds long.
  const open = await repo.findReusableCheckoutClaim(ctx.db, {
    workspaceId,
    userId,
    offerId: offer.id,
    priceId: input.priceId,
    createdAfter: now - CHECKOUT_REUSE_WINDOW_MS,
    now,
  });
  if (open !== null) return { ok: true, checkoutUrl: open.checkoutUrl, checkoutClaimId: open.id };
  const buckets = checkoutRateLimitBuckets({
    userId,
    ipHash: await keyedHash(deps, (key) => hashIp(key, input.ip)),
  });
  if (!(await repo.takeRateLimits(ctx.db, buckets, now))) {
    return { ok: false, reason: "rate_limited" };
  }

  const checkoutClaimId = ctx.ids.next();
  const reference = await signClaimReference({
    key: claimSigningKeysOf(deps.claimSigningKeys).current,
    workspaceId,
    checkoutClaimId,
    userId,
    offerId: offer.id,
  });
  let checkoutUrl: string | null;
  let transactionId: string;
  try {
    const transaction = await withPaddle(ctx, deps, connection, (client) =>
      client.createTransaction({
        priceId: input.priceId,
        customData: { [CLAIM_REFERENCE_KEY]: reference },
      }),
    );
    checkoutUrl = transaction.checkoutUrl;
    transactionId = transaction.id;
  } catch (error) {
    if (
      error instanceof PaddleApiError &&
      error.paddleCode === PaddleErrorCode.DefaultPaymentLinkNotSet
    ) {
      return { ok: false, reason: "no_default_payment_link" };
    }
    throw error;
  }
  if (checkoutUrl === null) return { ok: false, reason: "no_default_payment_link" };
  await repo.createCheckoutClaim(
    ctx.db,
    {
      id: checkoutClaimId,
      workspaceId,
      userId,
      offerId: offer.id,
      priceId: input.priceId,
      createdAt: now,
      expiresAt: now + CHECKOUT_CLAIM_LIFETIME_MS,
    },
    [
      workspaceEvent(ctx, "checkout.started", {
        workspaceId,
        actor: asAuditActor(input.user),
        targetId: checkoutClaimId,
        details: { offerId: offer.id, priceId: input.priceId },
      }),
    ],
  );
  // The transaction and its checkout URL are bookkeeping on the claim `checkout.started` just
  // recorded.
  await repo.setCheckoutClaimTransaction(ctx.db, {
    workspaceId,
    id: checkoutClaimId,
    transactionId,
    checkoutUrl,
  });
  return { ok: true, checkoutUrl, checkoutClaimId };
}

// Path 2: claiming by email -----------------------------------------------------------------

const emailSchema = z.email().max(254);

export type RequestClaimResult =
  | {
      /**
       * The same whether or not a purchase matches, and whether or not the request was rate
       * limited (threats T4, T5): show the same page. `outboxId` is only for the queue hand-off
       * (null when nothing was queued) and must never reach the response.
       */
      readonly status: "requested";
      readonly outboxId: string | null;
    }
  | { readonly status: "invalid_email" };

/**
 * A signed-in buyer asks for claim links for the email they paid with (`/c/:slug/claim`). Counts
 * the request against the per-email (in this workspace), per-user and per-IP limits (decision
 * 0012), counters in D1 taken all at once or not at all; a request that any limit refuses queues
 * nothing and counts against none. Otherwise the
 * email is stored only as an envelope on a claim request, with a `send_claim_email` job and
 * `claim.requested`. Matching happens in the job, off the request path. NotFound for an unknown
 * or suspended workspace.
 */
export async function requestClaim(
  context: ServiceContext,
  input: {
    readonly workspaceSlug: string;
    readonly email: string;
    readonly user: UserActor;
    readonly ip: string;
  },
  deps: CommerceDeps,
): Promise<RequestClaimResult> {
  const ctx = atOneInstant(context);
  const slug = parseWorkspaceSlug(input.workspaceSlug);
  const workspace = slug.ok ? await repo.findWorkspaceBySlug(ctx.db, slug.value) : null;
  if (workspace?.status !== "active") throw new NotFoundError("workspace not found");
  const email = emailSchema.safeParse(input.email.trim());
  if (!email.success) return { status: "invalid_email" };

  const now = ctx.clock.now();
  const workspaceId = workspace.id;
  const emailHash = await keyedHash(deps, (key) => hashClaimEmail(key, email.data));
  const buckets = claimRateLimitBuckets({
    workspaceId,
    emailHash,
    userId: input.user.userId,
    ipHash: await keyedHash(deps, (key) => hashIp(key, input.ip)),
  });
  // Counted in every bucket or in none, atomically: a refused request uses up no limit.
  if (!(await repo.takeRateLimits(ctx.db, buckets, now))) {
    return { status: "requested", outboxId: null };
  }

  const claimRequestId = ctx.ids.next();
  const emailEnvelope = await sealSecret({
    keyring: deps.credentialKeys,
    plaintext: email.data,
    aad: envelopeAad({ workspaceId, rowId: claimRequestId, purpose: "email" }),
  });
  const outbox: repo.NewOutboxRow = {
    id: ctx.ids.next(),
    kind: OutboxKind.SendClaimEmail,
    subjectId: encodeClaimRequestKey({ workspaceId, claimRequestId }),
    createdAt: now,
    availableAt: now,
    workspaceId,
  };
  await repo.createClaimRequest(
    ctx.db,
    {
      request: {
        id: claimRequestId,
        workspaceId,
        userId: input.user.userId,
        emailHash: emailHash.current,
        emailEnvelope,
        createdAt: now,
      },
      outbox,
    },
    [
      workspaceEvent(ctx, "claim.requested", {
        workspaceId,
        actor: asAuditActor(input.user),
        targetId: claimRequestId,
        details: {},
      }),
    ],
  );
  return { status: "requested", outboxId: outbox.id };
}

export interface SendClaimEmailResult {
  /**
   * `finished`: the request was handled and its email erased; `unavailable`: no mail transport or
   * no usable Paddle connection, so it finished without sending; `already_done`: handled before.
   */
  readonly outcome: "finished" | "unavailable" | "already_done";
  /** Claim links sent. */
  readonly sent: number;
}

const claimLink = (deps: CommerceDeps, token: string) =>
  `${deps.baseUrl.replace(/\/+$/, "")}/claim/${token}`;

function claimMessage(workspaceName: string, link: string) {
  const subject = `Claim your repository access from ${workspaceName}`;
  const text = [
    `Someone asked to link a purchase from ${workspaceName} to a GitHub account on ShareRepo.`,
    "",
    `To claim it, open this link while signed in to ShareRepo with your GitHub account: ${link}`,
    "",
    "The link works once and expires in 24 hours. If you did not ask for it, ignore this email.",
  ].join("\n");
  const html = `<p>Someone asked to link a purchase from ${escapeHtml(workspaceName)} to a GitHub account on ShareRepo.</p><p>To claim it, open <a href="${link}">this link</a> while signed in to ShareRepo with your GitHub account.</p><p>The link works once and expires in 24 hours. If you did not ask for it, ignore this email.</p>`;
  return { subject, text, html };
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * The `send_claim_email` job (decision 0012, path 2). Looks up the workspace's Paddle customers
 * with the requested email, keeps those ShareRepo already knows, issues a single-use 24-hour token
 * for each (only its hash is stored, `claim.token_issued`), and emails each link to the address
 * Paddle holds for that customer. The request finishes, erasing the email, in every case: also
 * when nothing matches, when mail or Paddle is unavailable, when the workspace was suspended
 * since the request (its links would not work), and when Paddle fails (the buyer can ask again;
 * keeping the address to retry is not worth it).
 */
export async function sendClaimEmail(
  context: ServiceContext,
  ref: ClaimRequestRef,
  deps: CommerceDeps & { readonly mail: MailPort | null },
): Promise<SendClaimEmailResult> {
  const ctx = atOneInstant(context);
  const { workspaceId, claimRequestId } = ref;
  const request = await repo.getClaimRequest(ctx.db, { workspaceId, id: claimRequestId });
  if (request === null || request.processedAt !== null) return { outcome: "already_done", sent: 0 };
  const now = ctx.clock.now();
  const finishEmpty = async (): Promise<SendClaimEmailResult> => {
    const done = await repo.finishClaimRequest(ctx.db, { workspaceId, id: claimRequestId, now });
    return { outcome: done.ok ? "unavailable" : "already_done", sent: 0 };
  };
  const { mail } = deps;
  const [workspace, connection] = await Promise.all([
    repo.getWorkspace(ctx.db, workspaceId) as Promise<repo.Workspace>,
    activePaddleConnection(ctx, workspaceId),
  ]);
  if (mail === null || connection === null || workspace.status !== "active") return finishEmpty();

  const { plaintext: email } = await openSecret({
    keyring: deps.credentialKeys,
    envelope: request.emailEnvelope as string,
    aad: envelopeAad({ workspaceId, rowId: claimRequestId, purpose: "email" }),
  });
  const matches: { customer: repo.Customer; to: string }[] = [];
  try {
    const candidates = await withPaddle(ctx, deps, connection, (client) =>
      client.listCustomersByEmail(email),
    );
    for (const candidate of candidates) {
      const customer = await repo.findCustomer(ctx.db, {
        workspaceId,
        source: "paddle",
        externalCustomerId: candidate.id,
      });
      if (customer === null) continue;
      const onFile = await withPaddle(ctx, deps, connection, (client) =>
        client.getCustomer(candidate.id),
      );
      matches.push({ customer, to: onFile.email });
    }
  } catch {
    return finishEmpty();
  }

  const issued = await Promise.all(
    matches.map(async (match) => ({ ...match, id: ctx.ids.next(), ...(await newClaimToken()) })),
  );
  const finished = await repo.finishClaimRequest(
    ctx.db,
    {
      workspaceId,
      id: claimRequestId,
      now,
      tokens: issued.map(({ id, customer, hash }) => ({
        id,
        workspaceId,
        customerId: customer.id,
        tokenHash: hash,
        createdAt: now,
        expiresAt: now + CLAIM_TOKEN_LIFETIME_MS,
      })),
    },
    issued.map(({ id, customer }) =>
      workspaceEvent(ctx, "claim.token_issued", {
        workspaceId,
        actor: SYSTEM,
        targetId: id,
        details: { claimRequestId, customerId: customer.id },
      }),
    ),
  );
  if (!finished.ok) return { outcome: "already_done", sent: 0 };
  let sent = 0;
  for (const { to, token } of issued) {
    try {
      await mail.send({ to, ...claimMessage(workspace.name, claimLink(deps, token)) });
      sent += 1;
    } catch {
      // The token stands unused and expires; the buyer can ask again.
    }
  }
  return { outcome: "finished", sent };
}

type ResolvedToken =
  | { readonly ok: true; readonly token: repo.ClaimToken; readonly workspace: repo.Workspace }
  | {
      readonly ok: false;
      readonly reason: EmailRejectionReason;
      /** The token, when one matched. */
      readonly token: repo.ClaimToken | null;
    };

/**
 * The claim token a link carries, with its workspace. A token of a suspended workspace is treated
 * as unknown: the page shows nothing of the workspace and nothing is recorded in it.
 */
async function resolveToken(ctx: ServiceContext, value: string): Promise<ResolvedToken> {
  const unknown = { ok: false, reason: ClaimRejectionReason.UnknownClaim, token: null } as const;
  if (!isClaimToken(value)) return unknown;
  const token = await repo.findClaimTokenByHash(ctx.db, await hashClaimToken(value));
  if (token === null) return unknown;
  // Workspaces are never deleted, so the token's exists.
  const workspace = (await repo.getWorkspace(ctx.db, token.workspaceId)) as repo.Workspace;
  if (workspace.status !== "active") return unknown;
  const usable = claimTokenUsable(token, ctx.clock.now());
  return usable.usable
    ? { ok: true, token, workspace }
    : { ok: false, reason: usable.reason, token };
}

export interface ClaimView {
  readonly workspace: { readonly slug: string; readonly name: string };
  /** The offers the customer's subscriptions carry, by name. */
  readonly offers: readonly string[];
  /** The GitHub account that will receive access (threat T7). */
  readonly account: ClaimantAccount;
  /** Whom the customer is linked to now: nobody, the claimant, or someone else (a relink). */
  readonly linked: "none" | "you" | "other";
}

export type ViewClaimResult =
  | { readonly ok: true; readonly view: ClaimView }
  | { readonly ok: false; readonly reason: EmailRejectionReason };

/**
 * The confirmation page behind an emailed link (`GET /claim/:token`). Reads only (threat T3): a
 * mail scanner that opens the link consumes nothing and records nothing. A token of a suspended
 * workspace is `unknown_claim`.
 */
export async function viewClaim(
  context: ServiceContext,
  input: { readonly token: string; readonly user: UserActor },
): Promise<ViewClaimResult> {
  const resolved = await resolveToken(context, input.token);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { token, workspace } = resolved;
  const { workspaceId, customerId } = token;
  const { db } = context;
  const [customers, identity] = await Promise.all([
    repo.listCustomersWithLinks(db, { workspaceId }),
    repo.findExternalIdentityForUser(db, { userId: input.user.userId, provider: "github" }),
  ]);
  // A token's customer belongs to its workspace (composite foreign key).
  const entry = customers.find((c) => c.customer.id === customerId) as repo.CustomerWithLink;
  const subscriptions = await Promise.all(
    entry.subscriptions.map(
      (s) =>
        repo.getSubscription(db, {
          workspaceId,
          subscriptionId: s.id,
        }) as Promise<repo.SubscriptionWithItems>,
    ),
  );
  const offers = await repo.findOffersForItems(db, {
    workspaceId,
    source: "paddle",
    externalItemIds: [...new Set(subscriptions.flatMap((s) => s.items))],
  });
  const claimant = identity as repo.ExternalIdentity;
  const linked =
    entry.subject === null
      ? "none"
      : entry.subject.externalSubjectId === claimant.externalUserId
        ? "you"
        : "other";
  return {
    ok: true,
    view: {
      workspace: { slug: workspace.slug, name: workspace.name },
      offers: offers.map((offer) => offer.name),
      account: accountOf(claimant),
      linked,
    },
  };
}

export type ConfirmClaimResult =
  | {
      readonly ok: true;
      /** The token's workspace, where the link queued its refreshes. */
      readonly workspaceId: string;
      readonly workspaceSlug: string;
      readonly outcome: "linked" | "relinked" | "already_linked";
    }
  | { readonly ok: false; readonly reason: EmailRejectionReason };

/**
 * Confirms an emailed claim (`POST /claim/:token`, decision 0012 path 2): links the token's
 * customer to the signed-in user's subject, consuming the token in the same batch, audited
 * `claim.completed`. Proof of the payment mailbox outranks an earlier link: a customer linked to
 * another subject moves (`customer.relinked`), and the refreshes queued with the link end the
 * previous subject's entitlements. A used or expired token is refused and audited
 * `claim.rejected`; an unknown one, or one of a suspended workspace, is refused as unknown
 * without a trace. A concurrent claim of the same token is a ConflictError.
 */
export async function confirmClaim(
  context: ServiceContext,
  input: { readonly token: string; readonly user: UserActor },
): Promise<ConfirmClaimResult> {
  const ctx = atOneInstant(context);
  const actor = asAuditActor(input.user);
  const resolved = await resolveToken(ctx, input.token);
  if (!resolved.ok) {
    const repeated = await repeatedConfirmation(ctx, resolved, input.user.userId);
    if (repeated !== null) return repeated;
    if (resolved.token !== null) {
      await repo.appendAuditEvents(ctx.db, [
        workspaceEvent(ctx, "claim.rejected", {
          workspaceId: resolved.token.workspaceId,
          actor,
          targetId: resolved.token.customerId,
          details: { path: LinkPath.Email, claimId: resolved.token.id, reason: resolved.reason },
        }),
      ]);
    }
    return { ok: false, reason: resolved.reason };
  }
  const { token, workspace } = resolved;
  const { workspaceId, customerId } = token;
  const now = ctx.clock.now();
  // A token's customer belongs to its workspace (composite foreign key).
  const customer = (await repo.getCustomer(ctx.db, { workspaceId, customerId })) as repo.Customer;
  const claimant = await claimantIn(ctx, workspaceId, input.user.userId);
  const decision = decideCustomerLink({
    currentSubjectId: customer.subjectId,
    proposedSubjectId: claimant.subjectId,
    path: LinkPath.Email,
  });
  const subjectId = await claimantSubjectId(ctx, workspaceId, claimant, actor);
  const completed = workspaceEvent(ctx, "claim.completed", {
    workspaceId,
    actor,
    targetId: customerId,
    details: { path: LinkPath.Email, claimId: token.id, userId: input.user.userId, subjectId },
  });
  let ok: boolean;
  if (decision === CustomerLinkDecision.Noop) {
    // Already linked to the claimant: the token is still used up.
    const consumed = await repo.consumeClaimToken(
      ctx.db,
      { workspaceId, id: token.id, userId: input.user.userId, now },
      [completed],
    );
    ok = consumed.ok;
  } else {
    const previousSubjectId = customer.subjectId;
    const audit: repo.AuditEvents =
      previousSubjectId === null
        ? [completed]
        : [
            workspaceEvent(ctx, "customer.relinked", {
              workspaceId,
              actor,
              targetId: customerId,
              details: { path: LinkPath.Email, previousSubjectId, subjectId },
            }),
            completed,
          ];
    const linked = await repo.applyCustomerLink(
      ctx.db,
      {
        workspaceId,
        customerId,
        expectedSubjectId: previousSubjectId,
        subjectId,
        now,
        makeRefreshRow: refreshRows(ctx, workspaceId),
        consume: { kind: "claim_token", id: token.id, userId: input.user.userId },
      },
      audit,
    );
    ok = linked.ok;
  }
  if (!ok) throw new ConflictError("the claim changed concurrently; retry");
  const outcome =
    decision === CustomerLinkDecision.Noop
      ? "already_linked"
      : decision === CustomerLinkDecision.Link
        ? "linked"
        : "relinked";
  return { ok: true, workspaceId: workspace.id, workspaceSlug: workspace.slug, outcome };
}

/**
 * The claimant confirming again a claim they already completed, as after a lost response or a
 * double submit: the token is used up by them and the customer is still linked to their subject.
 * That is the same success again, with nothing written; anything else is still refused.
 */
async function repeatedConfirmation(
  ctx: ServiceContext,
  resolved: Extract<ResolvedToken, { ok: false }>,
  userId: string,
): Promise<ConfirmClaimResult | null> {
  const { token } = resolved;
  if (
    token === null ||
    resolved.reason !== ClaimRejectionReason.AlreadyUsed ||
    token.consumedByUserId !== userId
  ) {
    return null;
  }
  const { workspaceId, customerId } = token;
  const customer = await repo.getCustomer(ctx.db, { workspaceId, customerId });
  const claimant = await claimantIn(ctx, workspaceId, userId);
  if (
    customer === null ||
    claimant.subject === null ||
    customer.subjectId !== claimant.subject.id
  ) {
    return null;
  }
  // An active workspace: `resolveToken` reports any other as unknown.
  const workspace = (await repo.getWorkspace(ctx.db, workspaceId)) as repo.Workspace;
  return { ok: true, workspaceId, workspaceSlug: workspace.slug, outcome: "already_linked" };
}

// Path 3: the owner's manual link -----------------------------------------------------------

const REASON_MAX_LENGTH = 500;

/**
 * Why a manual link was refused: `reason_required` (missing or longer than 500 characters),
 * `login_invalid`, `connection_missing` (no active GitHub connection to resolve the login with),
 * `login_not_found`, or `account_not_user` (an organization or bot).
 */
export type ManualLinkError =
  | "reason_required"
  | "login_invalid"
  | "connection_missing"
  | "login_not_found"
  | "account_not_user";

export type ManualLinkResult =
  | { readonly ok: true; readonly outcome: "linked" | "already_linked" }
  | { readonly ok: false; readonly error: ManualLinkError };

/**
 * Links a customer to a GitHub account by hand (decision 0012, path 3), as repair. Needs
 * `workspace.manage` and a reason. The login is resolved to its immutable ID through the
 * workspace's GitHub connection, as the simulator does. An existing link moves; the change is
 * audited `customer.linked_manually` with the actor, the reason and the previous subject.
 */
export async function linkCustomerManually(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly customerId: string; readonly githubLogin: string; readonly reason: string },
  deps: { readonly github: GitHubAppPort },
): Promise<ManualLinkResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const fail = (error: ManualLinkError) => ({ ok: false, error }) as const;
  const reason = input.reason.trim();
  if (reason === "" || reason.length > REASON_MAX_LENGTH) return fail("reason_required");
  if (!parseGitHubLogin(input.githubLogin.trim()).ok) return fail("login_invalid");
  const customer = await repo.getCustomer(ctx.db, { workspaceId, customerId: input.customerId });
  if (customer === null) throw new NotFoundError("customer not found in workspace");
  const resolved = await resolveGitHubAccount(ctx, workspaceId, input.githubLogin, deps.github);
  if (!resolved.ok) return fail(resolved.error);
  const user = resolved.account;

  const by = asAuditActor(actor);
  const subject = await subjectFor(
    ctx,
    workspaceId,
    { provider: "github", externalSubjectId: user.id, login: user.login },
    by,
  );
  if (subject.id === customer.subjectId) return { ok: true, outcome: "already_linked" };
  const result = await repo.applyCustomerLink(
    ctx.db,
    {
      workspaceId,
      customerId: customer.id,
      expectedSubjectId: customer.subjectId,
      subjectId: subject.id,
      now: ctx.clock.now(),
      makeRefreshRow: refreshRows(ctx, workspaceId),
    },
    [
      workspaceEvent(ctx, "customer.linked_manually", {
        workspaceId,
        actor: by,
        targetId: customer.id,
        reason,
        details: { previousSubjectId: customer.subjectId, subjectId: subject.id },
      }),
    ],
  );
  if (!result.ok) throw new ConflictError("the customer's link changed concurrently; retry");
  return { ok: true, outcome: "linked" };
}

export type ManualUnlinkResult =
  | { readonly ok: true; readonly outcome: "unlinked" | "already_unlinked" }
  | { readonly ok: false; readonly error: "reason_required" };

/**
 * Removes a customer's link by hand (decision 0016), whichever path made it, for example a link a
 * creator made through a checkout reference, or one a buyer made for someone else's purchase.
 * Needs `workspace.manage` and a reason. Its subscriptions are refreshed, so their entitlements
 * end (`customer_unlinked`) and reconciliation removes the access. The checkout claim the customer
 * used never links it again; the payer can claim by email (path 2), or an owner can link it (path
 * 3). Audited `customer.unlinked_manually` with the actor, the reason and the previous subject.
 */
export async function unlinkCustomerManually(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly customerId: string; readonly reason: string },
): Promise<ManualUnlinkResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const reason = input.reason.trim();
  if (reason === "" || reason.length > REASON_MAX_LENGTH) {
    return { ok: false, error: "reason_required" };
  }
  const customer = await repo.getCustomer(ctx.db, { workspaceId, customerId: input.customerId });
  if (customer === null) throw new NotFoundError("customer not found in workspace");
  if (customer.subjectId === null) return { ok: true, outcome: "already_unlinked" };
  const result = await repo.applyCustomerLink(
    ctx.db,
    {
      workspaceId,
      customerId: customer.id,
      expectedSubjectId: customer.subjectId,
      subjectId: null,
      now: ctx.clock.now(),
      makeRefreshRow: refreshRows(ctx, workspaceId),
    },
    [
      workspaceEvent(ctx, "customer.unlinked_manually", {
        workspaceId,
        actor: asAuditActor(actor),
        targetId: customer.id,
        reason,
        details: { previousSubjectId: customer.subjectId },
      }),
    ],
  );
  if (!result.ok) throw new ConflictError("the customer's link changed concurrently; retry");
  return { ok: true, outcome: "unlinked" };
}

// Views -------------------------------------------------------------------------------------

export interface CustomerSummary {
  readonly id: string;
  readonly source: CommercialSource;
  /** Paddle's `ctm_…` (or the simulator's customer key). */
  readonly externalCustomerId: string;
  /** The linked GitHub account, or null when the customer is not claimed. */
  readonly linked: {
    readonly subjectId: string;
    readonly login: string;
    readonly externalSubjectId: string;
    /**
     * How the link was made, from the audit trail: a checkout reference, an emailed claim, an
     * owner's manual link, or the source (the simulator). Null when the trail does not say.
     */
    readonly via: repo.CustomerLinkVia | null;
  } | null;
  readonly subscriptions: readonly repo.CustomerSubscriptionSummary[];
}

/** The Customers page: the workspace's customers, links and subscription states. Owner only. */
export async function listCustomers(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<CustomerSummary[]> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.manage");
  const [rows, via] = await Promise.all([
    repo.listCustomersWithLinks(context.db, { workspaceId: scope.workspaceId }),
    repo.listCustomerLinkPaths(context.db, scope.workspaceId),
  ]);
  return rows.map(({ customer, subject, subscriptions }) => ({
    id: customer.id,
    source: customer.source,
    externalCustomerId: customer.externalCustomerId,
    linked:
      subject === null
        ? null
        : {
            subjectId: subject.id,
            login: subject.login,
            externalSubjectId: subject.externalSubjectId,
            via: via.get(customer.id) ?? null,
          },
    subscriptions,
  }));
}

/**
 * "My access": the signed-in user's own linked subscriptions across workspaces, with their
 * repositories, entitlement and grant states. Reached only through the user's GitHub identity, so
 * nothing of another user can appear.
 */
export function myAccess(
  context: ServiceContext,
  user: UserActor,
): Promise<repo.MyAccessSubscription[]> {
  return repo.listMyAccess(context.db, { userId: user.userId });
}
