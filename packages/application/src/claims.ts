import * as repo from "@sharerepo/db";
import {
  type AuditDetails,
  type AuditEvent,
  type AuditEventInput,
  auditEvent,
  CHECKOUT_CLAIM_LIFETIME_MS,
  CLAIM_TOKEN_LIFETIME_MS,
  ClaimRejectionReason,
  type CommercialSource,
  CustomerLinkDecision,
  checkoutClaimUsable,
  claimRateLimitBuckets,
  claimTokenUsable,
  decideCustomerLink,
  type EMAIL_REJECTION_REASONS,
  LinkPath,
  OutboxKind,
  parseGitHubLogin,
  parseWorkspaceSlug,
  rateLimitDecision,
  rateLimitWindowStart,
} from "@sharerepo/domain";
import {
  CLAIM_REFERENCE_KEY,
  GitHubApiError,
  type GitHubAppPort,
  type MailPort,
  PaddleApiError,
  PaddleErrorCode,
} from "@sharerepo/integrations";
import {
  ConflictError,
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
import { type ClaimRequestRef, encodeClaimRequestKey } from "./entitlement-source.ts";
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
 * linked to another subject is never moved (threat T8): `claim.conflict`.
 *
 * A linked customer is looked at again only when the refresh applied newer facts, so renewals
 * stay silent and a conflict is recorded once per change rather than once per refresh.
 */
export async function linkCheckoutReference(
  context: ServiceContext,
  workspaceId: string,
  reported: ReportedClaim,
  key: Uint8Array,
): Promise<void> {
  const { customer, reference, newer } = reported;
  if (customer.subjectId !== null && !newer) return;
  const ctx = atOneInstant(context);
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
  const verified = await verifyClaimReference({
    key,
    reference,
    workspaceId,
    userId: claim.userId,
    offerId: claim.offerId,
  });
  if (!verified) return reject(ClaimRejectionReason.SignatureInvalid, null);
  const usable = checkoutClaimUsable(claim, { now, customerId: customer.id });
  if (!usable.usable) return reject(usable.reason, claim.id);

  const claimant = await claimantIn(ctx, workspaceId, claim.userId);
  const decision = decideCustomerLink({
    currentSubjectId: customer.subjectId,
    proposedSubjectId: claimant.subjectId,
    path: LinkPath.Checkout,
  });
  if (decision === CustomerLinkDecision.Noop) return;
  if (decision === CustomerLinkDecision.Conflict) {
    return record(
      workspaceEvent(ctx, "claim.conflict", {
        workspaceId,
        actor: SYSTEM,
        targetId: customer.id,
        details: {
          path: LinkPath.Checkout,
          claimId: claim.id,
          subjectId: customer.subjectId as string,
          userId: claim.userId,
        },
      }),
    );
  }
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
       * payment link Paddle needs (the page names the setup step).
       */
      readonly reason: "not_found" | "unavailable" | "price_invalid" | "no_default_payment_link";
    };

/**
 * Starts checkout for a signed-in buyer (decision 0012, path 1): a Paddle transaction for the
 * price, carrying the signed reference of a new checkout claim bound to the workspace, the buyer
 * and the offer (7 days), audited `checkout.started`. Nothing is stored when Paddle refuses.
 */
export async function startCheckout(
  context: ServiceContext,
  input: { readonly offerId: string; readonly priceId: string; readonly user: UserActor },
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
  const checkoutClaimId = ctx.ids.next();
  const reference = await signClaimReference({
    key: deps.claimSigningKey,
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
  const now = ctx.clock.now();
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
  // The transaction ID is bookkeeping on the claim `checkout.started` just recorded.
  await repo.setCheckoutClaimTransaction(ctx.db, {
    workspaceId,
    id: checkoutClaimId,
    transactionId,
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
 * the request against the per-email, per-user and per-IP limits (decision 0012), each an atomic
 * counter in D1; a request that takes any counter past its limit queues nothing. Otherwise the
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
  const key = deps.claimSigningKey;
  const emailHash = await hashClaimEmail(key, email.data);
  const buckets = claimRateLimitBuckets({
    emailHash,
    userId: input.user.userId,
    ipHash: await hashIp(key, input.ip),
  });
  // The database counts atomically; the domain decides from the count before this request.
  const counts = await repo.hitRateLimits(ctx.db, buckets, now);
  const decision = rateLimitDecision(
    buckets,
    buckets.map(({ bucket, windowMs }, i) => ({
      bucket,
      windowStart: rateLimitWindowStart(windowMs, now),
      count: (counts[i] as number) - 1,
    })),
    now,
  );
  if (!decision.allowed) return { status: "requested", outboxId: null };

  const workspaceId = workspace.id;
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
  };
  await repo.createClaimRequest(
    ctx.db,
    {
      request: {
        id: claimRequestId,
        workspaceId,
        userId: input.user.userId,
        emailHash,
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
 * when nothing matches, when mail or Paddle is unavailable, and when Paddle fails (the buyer can
 * ask again; keeping the address to retry is not worth it).
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
  const connection = await activePaddleConnection(ctx, workspaceId);
  if (mail === null || connection === null) return finishEmpty();

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
  const workspace = (await repo.getWorkspace(ctx.db, workspaceId)) as repo.Workspace;
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
  | { readonly ok: true; readonly token: repo.ClaimToken }
  | {
      readonly ok: false;
      readonly reason: EmailRejectionReason;
      /** The token, when one matched. */
      readonly token: repo.ClaimToken | null;
    };

async function resolveToken(ctx: ServiceContext, value: string): Promise<ResolvedToken> {
  const unknown = { ok: false, reason: ClaimRejectionReason.UnknownClaim, token: null } as const;
  if (!isClaimToken(value)) return unknown;
  const token = await repo.findClaimTokenByHash(ctx.db, await hashClaimToken(value));
  if (token === null) return unknown;
  const usable = claimTokenUsable(token, ctx.clock.now());
  return usable.usable ? { ok: true, token } : { ok: false, reason: usable.reason, token };
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
 * mail scanner that opens the link consumes nothing and records nothing.
 */
export async function viewClaim(
  context: ServiceContext,
  input: { readonly token: string; readonly user: UserActor },
): Promise<ViewClaimResult> {
  const resolved = await resolveToken(context, input.token);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { workspaceId, customerId } = resolved.token;
  const { db } = context;
  const [workspace, customers, identity] = await Promise.all([
    repo.getWorkspace(db, workspaceId) as Promise<repo.Workspace>,
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
 * `claim.rejected`; an unknown one is refused without a trace (it names no workspace). A
 * concurrent claim of the same token is a ConflictError.
 */
export async function confirmClaim(
  context: ServiceContext,
  input: { readonly token: string; readonly user: UserActor },
): Promise<ConfirmClaimResult> {
  const ctx = atOneInstant(context);
  const actor = asAuditActor(input.user);
  const resolved = await resolveToken(ctx, input.token);
  if (!resolved.ok) {
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
  const { token } = resolved;
  const { workspaceId, customerId } = token;
  const now = ctx.clock.now();
  const [customer, workspace] = (await Promise.all([
    repo.getCustomer(ctx.db, { workspaceId, customerId }),
    repo.getWorkspace(ctx.db, workspaceId),
  ])) as [repo.Customer, repo.Workspace];
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
  return { ok: true, workspaceSlug: workspace.slug, outcome };
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
  const login = parseGitHubLogin(input.githubLogin.trim());
  if (!login.ok) return fail("login_invalid");
  const customer = await repo.getCustomer(ctx.db, { workspaceId, customerId: input.customerId });
  if (customer === null) throw new NotFoundError("customer not found in workspace");
  const connection = (await repo.listConnectionsForWorkspace(ctx.db, workspaceId)).find(
    (candidate) => candidate.status === "active",
  );
  if (connection === undefined) return fail("connection_missing");
  let user: Awaited<ReturnType<GitHubAppPort["getUserByLogin"]>>;
  try {
    user = await deps.github.getUserByLogin(connection.installationId, login.value);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === "not_found") {
      return fail("login_not_found");
    }
    throw error;
  }
  if (user.type !== "User") return fail("account_not_user");

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
  const rows = await repo.listCustomersWithLinks(context.db, { workspaceId: scope.workspaceId });
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
