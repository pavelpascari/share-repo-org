import * as repo from "@sharerepo/db";
import {
  type AccessDecisionReason,
  type AuditDetails,
  type AuditEvent,
  type AuditEventInput,
  auditEvent,
  type CommercialSource,
  type EntitlementPlan,
  isNewerSnapshot,
  type LiveEntitlement,
  type PlanOffer,
  type PlanSubscription,
  planEntitlements,
  type SubscriptionSnapshot,
} from "@sharerepo/domain";
import { ConflictError } from "@sharerepo/platform";
import { atOneInstant, type ServiceContext, type WorkspaceAuditAction } from "./context.ts";
import {
  type CustomerLink,
  type EntitlementSourcePort,
  encodeRefreshKey,
  type OfferRef,
  type SubscriptionRef,
} from "./entitlement-source.ts";

// Processing (phase-3 plan § Processing): commercial events are hints. A refresh re-reads the
// source, applies the snapshot only if it is newer, recomputes the subscription's entitlements,
// and writes everything in one batch conditional on the subscription version it read.

const SYSTEM = { type: "system", id: null } as const;
const MAX_REFRESH_ATTEMPTS = 3;

export interface RefreshSummary {
  /**
   * `absent`: neither the source nor ShareRepo has the subscription; `unchanged`: nothing to
   * write; `written`: the subscription and its entitlements were brought up to date.
   */
  readonly outcome: "absent" | "unchanged" | "written";
  readonly created: number;
  readonly updated: number;
  readonly ended: number;
}

/**
 * Brings one subscription and its entitlements up to date with its source. System work, safe to
 * run any number of times in any order: an equal or older snapshot never replaces newer facts,
 * but entitlements are still recomputed from the stored facts, so time-based re-evaluation and
 * offer recomputes use this same path. A concurrent writer makes an attempt write nothing; after
 * three such attempts it throws a retryable ConflictError.
 */
export async function refreshSubscription(
  context: ServiceContext,
  ref: SubscriptionRef,
  source: EntitlementSourcePort,
): Promise<RefreshSummary> {
  if (source.source !== ref.source) throw new Error("entitlement source does not match the ref");
  for (let attempt = 1; ; attempt += 1) {
    const result = await attemptRefresh(context, ref, source);
    if (result !== "stale") return result;
    if (attempt === MAX_REFRESH_ATTEMPTS) {
      throw new ConflictError("subscription kept changing during refresh; retry later");
    }
  }
}

const SUBJECT_KEY = [
  "subjects.workspace_id",
  "subjects.provider",
  "subjects.external_subject_id",
] as const;

/**
 * The workspace's subject for a linked GitHub account, created (and audited) on first sight in a
 * write of its own. Another refresh may create it first; then it is read again.
 */
async function subjectFor(
  ctx: ServiceContext,
  workspaceId: string,
  link: CustomerLink,
): Promise<repo.Subject> {
  const key = { workspaceId, provider: link.provider, externalSubjectId: link.externalSubjectId };
  const existing = await repo.findSubjectByExternalId(ctx.db, key);
  if (existing !== null) return existing;
  const now = ctx.clock.now();
  const subject: repo.Subject = {
    id: ctx.ids.next(),
    workspaceId,
    provider: link.provider,
    type: "user",
    externalSubjectId: link.externalSubjectId,
    loginSnapshot: link.login,
    externalIdentityId: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await repo.insertSubject(ctx.db, subject, [
      auditEvent(
        "subject.created",
        {
          workspaceId,
          actor: SYSTEM,
          targetId: subject.id,
          details: {
            provider: link.provider,
            externalSubjectId: link.externalSubjectId,
            login: link.login,
          },
        },
        ctx,
      ),
    ]);
    return subject;
  } catch (error) {
    if (!repo.isUniqueViolation(error, SUBJECT_KEY)) throw error;
    return (await repo.findSubjectByExternalId(ctx.db, key)) as repo.Subject;
  }
}

/** The commercial facts a refresh plans from: the newer snapshot, or what is stored. */
type Facts = Omit<SubscriptionSnapshot, "externalSubscriptionId" | "externalCustomerId">;

function storedFacts(stored: repo.SubscriptionWithItems): Facts {
  return {
    items: stored.items,
    state: stored.state,
    providerState: stored.providerState,
    currentPeriodStart: stored.currentPeriodStart,
    currentPeriodEnd: stored.currentPeriodEnd,
    cancelAt: stored.cancelAt,
    endedAt: stored.endedAt,
    pastDueSince: stored.pastDueSince,
    sourceUpdatedAt: stored.sourceUpdatedAt,
  };
}

function planOffer(offer: repo.OfferWithConfig, source: CommercialSource): PlanOffer {
  return {
    offerId: offer.id,
    version: offer.version,
    status: offer.status,
    gracePeriodDays: offer.gracePeriodDays,
    items: offer.items.filter((item) => item.source === source).map((i) => i.externalItemId),
    accesses: offer.accesses.map(({ resourceId, accessLevel }) => ({ resourceId, accessLevel })),
  };
}

const liveEntitlement = (row: repo.Entitlement): LiveEntitlement => ({
  id: row.id,
  offerId: row.offerId,
  offerVersion: row.offerVersion,
  resourceId: row.resourceId,
  subjectId: row.subjectId,
  accessLevel: row.accessLevel,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
  decisionReason: row.decisionReason as AccessDecisionReason,
  policyVersion: row.policyVersion,
});

/** Every offer the plan needs: those carrying the items, and those live entitlements refer to. */
async function offersFor(
  ctx: ServiceContext,
  ref: SubscriptionRef,
  items: readonly string[],
  live: readonly repo.Entitlement[],
): Promise<PlanOffer[]> {
  const carrying = await repo.findOffersForItems(ctx.db, {
    workspaceId: ref.workspaceId,
    source: ref.source,
    externalItemIds: items,
  });
  const known = new Set(carrying.map((offer) => offer.id));
  const referenced = await repo.listOffersByIds(ctx.db, {
    workspaceId: ref.workspaceId,
    offerIds: [...new Set(live.map((e) => e.offerId))].filter((id) => !known.has(id)),
  });
  return [...carrying, ...referenced].map((offer) => planOffer(offer, ref.source));
}

const planSize = (plan: EntitlementPlan) =>
  plan.create.length + plan.update.length + plan.end.length;

async function attemptRefresh(
  context: ServiceContext,
  ref: SubscriptionRef,
  port: EntitlementSourcePort,
): Promise<RefreshSummary | "stale"> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const { workspaceId } = ref;
  // Stored state first: a writer that commits after this read makes the final write stale.
  const stored = await repo.getSubscriptionByExternal(ctx.db, ref);
  const live =
    stored === null
      ? []
      : await repo.listLiveEntitlementsForSubscription(ctx.db, {
          workspaceId,
          subscriptionId: stored.id,
        });
  const observed = await port.refreshSubscription({
    workspaceId,
    externalSubscriptionId: ref.externalSubscriptionId,
  });
  if (!observed.found && stored === null) {
    return { outcome: "absent", created: 0, updated: 0, ended: 0 };
  }
  const snapshot = observed.found && isNewerSnapshot(stored, observed.snapshot) ? observed : null;
  const audit: AuditEvent[] = [];
  const event = <A extends WorkspaceAuditAction>(
    action: A,
    targetId: string,
    details: AuditDetails<A>,
  ) =>
    audit.push(
      auditEvent(
        action,
        // TypeScript cannot resolve WorkspaceField<A> for a generic A; A is workspace-scoped here.
        { workspaceId, actor: SYSTEM, targetId, details } as unknown as AuditEventInput<A>,
        ctx,
      ),
    );

  // The customer, and the subject it is linked to.
  let customer: repo.Customer | null;
  let newCustomer: repo.Customer | undefined;
  let customerLink: repo.SubscriptionRefresh["customerLink"];
  if (snapshot === null) {
    customer = await repo.getCustomer(ctx.db, {
      workspaceId,
      customerId: (stored as repo.SubscriptionWithItems).customerId,
    });
  } else {
    customer = await repo.findCustomer(ctx.db, {
      workspaceId,
      source: ref.source,
      externalCustomerId: snapshot.snapshot.externalCustomerId,
    });
    // A source without a link (null) leaves an existing link alone: Phase 5 claims link
    // customers that the source itself knows nothing about.
    const subject =
      snapshot.customerLink === null
        ? null
        : await subjectFor(ctx, workspaceId, snapshot.customerLink);
    if (customer === null) {
      customer = {
        id: ctx.ids.next(),
        workspaceId,
        source: ref.source,
        externalCustomerId: snapshot.snapshot.externalCustomerId,
        subjectId: subject?.id ?? null,
        createdAt: now,
        updatedAt: now,
      };
      newCustomer = customer;
      event("customer.created", customer.id, {
        source: ref.source,
        externalCustomerId: customer.externalCustomerId,
      });
      if (subject !== null) {
        event("customer.linked", customer.id, { previousSubjectId: null, subjectId: subject.id });
      }
    } else if (subject !== null && subject.id !== customer.subjectId) {
      event("customer.linked", customer.id, {
        previousSubjectId: customer.subjectId,
        subjectId: subject.id,
      });
      customerLink = { customerId: customer.id, subjectId: subject.id };
      customer = { ...customer, subjectId: subject.id };
    }
  }
  const { id: customerId, subjectId } = customer as repo.Customer;

  // The plan, from the newer snapshot or the stored facts.
  const facts: Facts = snapshot?.snapshot ?? storedFacts(stored as repo.SubscriptionWithItems);
  const subscriptionId = stored?.id ?? ctx.ids.next();
  const planned: PlanSubscription | null = observed.found
    ? {
        id: subscriptionId,
        items: facts.items,
        state: facts.state,
        cancelAt: facts.cancelAt,
        endedAt: facts.endedAt,
        pastDueSince: facts.pastDueSince,
      }
    : null;
  const plan = planEntitlements({
    now,
    subscription: planned,
    subjectId,
    offers: await offersFor(ctx, ref, facts.items, live),
    live: live.map(liveEntitlement),
  });

  const changed =
    snapshot !== null ||
    planSize(plan) > 0 ||
    plan.nextEvaluationAt !== (stored as repo.SubscriptionWithItems).nextEvaluationAt;
  if (!changed) return { outcome: "unchanged", created: 0, updated: 0, ended: 0 };

  const subscription: repo.Subscription = {
    id: subscriptionId,
    workspaceId,
    source: ref.source,
    externalSubscriptionId: ref.externalSubscriptionId,
    customerId,
    state: facts.state,
    providerState: facts.providerState,
    currentPeriodStart: facts.currentPeriodStart,
    currentPeriodEnd: facts.currentPeriodEnd,
    cancelAt: facts.cancelAt,
    endedAt: facts.endedAt,
    pastDueSince: facts.pastDueSince,
    sourceUpdatedAt: facts.sourceUpdatedAt,
    lastObservedAt: now,
    nextEvaluationAt: plan.nextEvaluationAt,
    version: (stored?.version ?? 0) + 1,
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
  };
  if (stored === null) {
    event("subscription.recorded", subscriptionId, {
      source: ref.source,
      externalSubscriptionId: ref.externalSubscriptionId,
      state: facts.state,
    });
  } else if (snapshot !== null || planSize(plan) === 0) {
    // A newer snapshot; or a write that only reschedules evaluation, which is still audited.
    event("subscription.updated", subscriptionId, {
      previousState: stored.state,
      state: facts.state,
      sourceUpdatedAt: facts.sourceUpdatedAt,
    });
  }
  const created = plan.create.map((entitlement): repo.NewEntitlement => {
    const row = {
      ...entitlement,
      id: ctx.ids.next(),
      workspaceId,
      sourceType: "subscription",
      sourceId: subscriptionId,
      state: "active",
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    } as const;
    event("entitlement.created", row.id, {
      subjectId: row.subjectId,
      resourceId: row.resourceId,
      accessLevel: row.accessLevel,
      subscriptionId,
      offerId: row.offerId,
      offerVersion: row.offerVersion,
      policyVersion: row.policyVersion,
      validUntil: row.validUntil,
      reason: row.decisionReason,
    });
    return row;
  });
  const previous = new Map(live.map((row) => [row.id, row]));
  for (const { id, set } of plan.update) {
    event("entitlement.updated", id, {
      validUntil: { from: (previous.get(id) as repo.Entitlement).validUntil, to: set.validUntil },
      reason: set.decisionReason,
      offerVersion: set.offerVersion,
      policyVersion: set.policyVersion,
    });
  }
  for (const { id, state, reason } of plan.end) {
    event("entitlement.ended", id, { state, reason });
  }

  const result = await repo.applySubscriptionRefresh(
    ctx.db,
    {
      workspaceId,
      now,
      expectedVersion: stored?.version ?? 0,
      ...(newCustomer === undefined ? {} : { customer: newCustomer }),
      ...(customerLink === undefined ? {} : { customerLink }),
      subscription,
      items: facts.items,
      entitlements: { create: created, update: plan.update, end: plan.end },
    },
    audit as [AuditEvent, ...AuditEvent[]],
  );
  if (!result.ok) return "stale";
  return {
    outcome: "written",
    created: plan.create.length,
    updated: plan.update.length,
    ended: plan.end.length,
  };
}

function refreshOutboxRow(ctx: ServiceContext, ref: SubscriptionRef): repo.NewOutboxRow {
  const now = ctx.clock.now();
  return {
    id: ctx.ids.next(),
    kind: "refresh_subscription",
    subjectId: encodeRefreshKey(ref),
    createdAt: now,
    availableAt: now,
  };
}

/**
 * Queues a `refresh_subscription` for every subscription an offer change affects: those carrying
 * the offer's items and those with a live entitlement from it. Duplicates are harmless because a
 * refresh is idempotent. Returns how many it queued.
 */
export async function recomputeOffer(context: ServiceContext, ref: OfferRef): Promise<number> {
  const ctx = atOneInstant(context);
  const ids = await repo.listSubscriptionIdsForOffer(ctx.db, ref);
  const rows: repo.NewOutboxRow[] = [];
  for (const subscriptionId of ids) {
    const subscription = (await repo.getSubscription(ctx.db, {
      workspaceId: ref.workspaceId,
      subscriptionId,
    })) as repo.SubscriptionWithItems;
    rows.push(
      refreshOutboxRow(ctx, {
        workspaceId: ref.workspaceId,
        source: subscription.source,
        externalSubscriptionId: subscription.externalSubscriptionId,
      }),
    );
  }
  for (const row of rows) await repo.enqueueOutbox(ctx.db, row);
  return rows.length;
}

/**
 * The per-minute sweep: queues a `refresh_subscription` for up to `limit` subscriptions, in any
 * workspace, whose next policy boundary has passed. Returns how many it queued.
 */
export async function queueDueEvaluations(
  context: ServiceContext,
  input: { readonly limit: number },
): Promise<number> {
  const ctx = atOneInstant(context);
  return repo.claimDueEvaluations(ctx.db, {
    now: ctx.clock.now(),
    limit: input.limit,
    makeOutboxRow: (subscription) =>
      refreshOutboxRow(ctx, {
        workspaceId: subscription.workspaceId,
        source: subscription.source,
        externalSubscriptionId: subscription.externalSubscriptionId,
      }),
  });
}
