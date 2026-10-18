import * as repo from "@sharerepo/db";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  auditEvent,
  type ConnectionStatus,
  checkOfferAccesses,
  isSellable,
  type OfferAccessError,
  type OfferChange,
  type OfferInput,
  type OfferInputError,
  type OfferResource,
  type OfferSnapshot,
  type OfferStatus,
  parseOfferInput,
  parseResourceCapabilities,
  type ResourceCapabilities,
  type ResourceSelection,
  supportsAccessLevel,
  type WorkspaceScope,
} from "@sharerepo/domain";
import { ConflictError, NotFoundError } from "@sharerepo/platform";
import { asAuditActor, atOneInstant, type ServiceContext, type UserActor } from "./context.ts";
import { encodeOfferKey } from "./entitlement-source.ts";
import { openWorkspace } from "./workspaces.ts";

// Offers (phase-3 plan § Commercial side): every configuration change is a new version with an
// immutable snapshot, and edits queue a recompute of the subscriptions that carry the offer.

/** What a member sees of an offer, at its current version. */
export interface OfferSummary extends OfferInput {
  readonly id: string;
  readonly status: OfferStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Why an offer change was refused. `input` errors come from `parseOfferInput`; `access` errors
 * name the refused repository; `item_taken` means another offer already sells one of the items;
 * `offer_archived` means archived offers are read-only.
 */
export type OfferFieldError =
  | { readonly field: "input"; readonly code: OfferInputError }
  | { readonly field: "access"; readonly resourceId: string; readonly code: OfferAccessError }
  | { readonly field: "items"; readonly code: "item_taken" }
  | { readonly field: "offer"; readonly code: "offer_archived" };

export type OfferResult =
  | {
      readonly ok: true;
      readonly offer: OfferSummary;
      /** The `recompute_offer` outbox row to hand to the queue, when the change queued one. */
      readonly outboxId: string | null;
    }
  | { readonly ok: false; readonly errors: readonly OfferFieldError[] };

const ITEM_KEY = [
  "offer_items.workspace_id",
  "offer_items.source",
  "offer_items.external_item_id",
] as const;

function summary(offer: repo.OfferWithConfig): OfferSummary {
  return {
    id: offer.id,
    name: offer.name,
    status: offer.status,
    gracePeriodDays: offer.gracePeriodDays,
    version: offer.version,
    items: offer.items.map(({ source, externalItemId }) => ({ source, externalItemId })),
    accesses: offer.accesses.map(({ resourceId, accessLevel }) => ({ resourceId, accessLevel })),
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

/** Stored capabilities, or the most conservative ones (write only) if they cannot be read. */
export function capabilitiesOf(
  resource: repo.Resource,
): Pick<ResourceCapabilities, "readOnlyGrant"> {
  const parsed = parseResourceCapabilities(JSON.parse(resource.capabilities));
  return parsed.ok ? parsed.value : { readOnlyGrant: false };
}

async function offerResources(ctx: ServiceContext, scope: WorkspaceScope) {
  const [resources, connections] = await Promise.all([
    repo.listResourcesForWorkspace(ctx.db, scope.workspaceId),
    repo.listConnectionsForWorkspace(ctx.db, scope.workspaceId),
  ]);
  const statuses = new Map(connections.map((c) => [c.id, c.status]));
  return resources.map((resource) => ({
    resource,
    offerResource: {
      id: resource.id,
      private: resource.private,
      archived: resource.archived,
      selection: resource.selection,
      capabilities: capabilitiesOf(resource),
      // A resource always belongs to a connection of its workspace (composite foreign key).
      connectionStatus: statuses.get(resource.connectionId) as ConnectionStatus,
    } satisfies OfferResource,
  }));
}

/** Parses and checks an offer configuration against the workspace's repositories. */
async function validate(
  ctx: ServiceContext,
  scope: WorkspaceScope,
  input: unknown,
  previousResourceIds: readonly string[],
): Promise<{ ok: true; value: OfferInput } | { ok: false; errors: OfferFieldError[] }> {
  const parsed = parseOfferInput(input);
  if (!parsed.ok) return { ok: false, errors: [{ field: "input", code: parsed.error }] };
  const resources = await offerResources(ctx, scope);
  const problems = checkOfferAccesses(parsed.value.accesses, {
    resources: resources.map((r) => r.offerResource),
    previousResourceIds,
  });
  if (problems.length > 0) {
    return {
      ok: false,
      errors: problems.map(({ resourceId, error }) => ({
        field: "access",
        resourceId,
        code: error,
      })),
    };
  }
  return { ok: true, value: parsed.value };
}

const itemTaken = { ok: false, errors: [{ field: "items", code: "item_taken" }] } as const;

function configRows(
  ctx: ServiceContext,
  workspaceId: string,
  offerId: string,
  config: OfferInput,
  now: number,
) {
  return {
    items: config.items.map((item) => ({
      id: ctx.ids.next(),
      workspaceId,
      offerId,
      source: item.source,
      externalItemId: item.externalItemId,
      createdAt: now,
    })),
    accesses: config.accesses.map((access) => ({
      id: ctx.ids.next(),
      workspaceId,
      offerId,
      resourceId: access.resourceId,
      accessLevel: access.accessLevel,
      createdAt: now,
    })),
  };
}

function versionRow(
  ctx: ServiceContext,
  actor: UserActor,
  workspaceId: string,
  offerId: string,
  version: number,
  config: OfferInput,
  now: number,
): repo.OfferVersion {
  const snapshot: OfferSnapshot = {
    name: config.name,
    gracePeriodDays: config.gracePeriodDays,
    items: config.items,
    accesses: config.accesses,
  };
  return {
    id: ctx.ids.next(),
    workspaceId,
    offerId,
    version,
    snapshot: JSON.stringify(snapshot),
    createdAt: now,
    createdByUserId: actor.userId,
  };
}

/** Every offer of the workspace, archived ones included, for any member. */
export async function listOffers(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<OfferSummary[]> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.read");
  return (await repo.listOffers(context.db, scope.workspaceId)).map(summary);
}

/** A repository as the offer form shows it. */
export interface OfferableResource {
  readonly id: string;
  readonly name: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly selection: ResourceSelection;
  /** Whether it can be added to an offer now. */
  readonly sellable: boolean;
  /** The access levels its capabilities support. */
  readonly accessLevels: readonly AccessLevel[];
}

/** The workspace's repositories, with whether each can be sold and at which levels. */
export async function listOfferableResources(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<OfferableResource[]> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.read");
  return (await offerResources(context, scope)).map(({ resource, offerResource }) => ({
    id: resource.id,
    name: resource.nameSnapshot,
    private: resource.private,
    archived: resource.archived,
    selection: resource.selection,
    sellable: isSellable(resource, offerResource.connectionStatus),
    accessLevels: ACCESS_LEVELS.filter((level) =>
      supportsAccessLevel(offerResource.capabilities, level),
    ),
  }));
}

/** Creates an offer at version 1. Needs `workspace.manage`. */
export async function createOffer(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: unknown,
): Promise<OfferResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const valid = await validate(ctx, scope, input, []);
  if (!valid.ok) return valid;
  const config = valid.value;
  const now = ctx.clock.now();
  const { workspaceId } = scope;
  const offerId = ctx.ids.next();
  const offer: repo.Offer = {
    id: offerId,
    workspaceId,
    name: config.name,
    status: "active",
    gracePeriodDays: config.gracePeriodDays,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const rows = configRows(ctx, workspaceId, offerId, config, now);
  try {
    await repo.createOffer(
      ctx.db,
      {
        offer,
        version: versionRow(ctx, actor, workspaceId, offerId, 1, config, now),
        ...rows,
      },
      [
        auditEvent(
          "offer.created",
          {
            workspaceId,
            actor: asAuditActor(actor),
            targetId: offerId,
            details: {
              name: config.name,
              version: 1,
              gracePeriodDays: config.gracePeriodDays,
              items: config.items.length,
              accesses: config.accesses.length,
            },
          },
          ctx,
        ),
      ],
    );
  } catch (error) {
    if (repo.isUniqueViolation(error, ITEM_KEY)) return itemTaken;
    throw error;
  }
  return {
    ok: true,
    offer: summary({ ...offer, items: rows.items, accesses: rows.accesses }),
    outboxId: null,
  };
}

const keyed = (values: readonly object[]) => values.map((v) => JSON.stringify(v)).sort();

/** Which parts of an offer's configuration differ. */
function offerChanges(current: OfferInput, next: OfferInput): OfferChange[] {
  const same = (a: readonly object[], b: readonly object[]) =>
    JSON.stringify(keyed(a)) === JSON.stringify(keyed(b));
  const changes: OfferChange[] = [];
  if (current.name !== next.name) changes.push("name");
  if (current.gracePeriodDays !== next.gracePeriodDays) changes.push("gracePeriodDays");
  if (!same(current.items, next.items)) changes.push("items");
  if (!same(current.accesses, next.accesses)) changes.push("accesses");
  return changes;
}

async function openOffer(ctx: ServiceContext, actor: UserActor, slug: string, offerId: string) {
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const offer = await repo.getOffer(ctx.db, { workspaceId: scope.workspaceId, offerId });
  if (offer === null) throw new NotFoundError("offer not found in workspace");
  return { scope, offer };
}

/**
 * Writes a new version of an offer and queues one `recompute_offer`, in one batch. A concurrent
 * change makes it a ConflictError: the user retries on fresh state, edits are never re-applied
 * silently.
 */
async function writeVersion(
  ctx: ServiceContext,
  actor: UserActor,
  offer: repo.OfferWithConfig,
  next: { config: OfferInput; status: OfferStatus },
  audit: (version: number) => repo.AuditEvents,
): Promise<OfferResult> {
  const now = ctx.clock.now();
  const { workspaceId, id: offerId } = offer;
  const version = offer.version + 1;
  const rows = configRows(ctx, workspaceId, offerId, next.config, now);
  const outboxId = ctx.ids.next();
  let result: repo.UpdateOfferResult;
  try {
    result = await repo.updateOffer(
      ctx.db,
      {
        workspaceId,
        offerId,
        expectedVersion: offer.version,
        set: {
          name: next.config.name,
          gracePeriodDays: next.config.gracePeriodDays,
          status: next.status,
          updatedAt: now,
        },
        version: versionRow(ctx, actor, workspaceId, offerId, version, next.config, now),
        ...rows,
        outbox: [
          {
            id: outboxId,
            kind: "recompute_offer",
            subjectId: encodeOfferKey({ workspaceId, offerId }),
            createdAt: now,
            availableAt: now,
          },
        ],
      },
      audit(version),
    );
  } catch (error) {
    if (repo.isUniqueViolation(error, ITEM_KEY)) return itemTaken;
    throw error;
  }
  if (!result.ok) throw new ConflictError("offer changed concurrently; reload and retry");
  return {
    ok: true,
    offer: summary({
      ...offer,
      name: next.config.name,
      gracePeriodDays: next.config.gracePeriodDays,
      status: next.status,
      version,
      updatedAt: now,
      ...rows,
    }),
    outboxId,
  };
}

/**
 * Replaces an active offer's configuration. An unchanged configuration is a no-op: no version,
 * no audit, no recompute. A repository already in the offer may stay after it stops being
 * sellable; a new one must be sellable.
 */
export async function updateOffer(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  offerId: string,
  input: unknown,
): Promise<OfferResult> {
  const ctx = atOneInstant(context);
  const { scope, offer } = await openOffer(ctx, actor, slug, offerId);
  if (offer.status === "archived") {
    return { ok: false, errors: [{ field: "offer", code: "offer_archived" }] };
  }
  const current = summary(offer);
  const valid = await validate(
    ctx,
    scope,
    input,
    current.accesses.map((access) => access.resourceId),
  );
  if (!valid.ok) return valid;
  const changes = offerChanges(current, valid.value);
  if (changes.length === 0) return { ok: true, offer: current, outboxId: null };

  return writeVersion(ctx, actor, offer, { config: valid.value, status: "active" }, (version) => [
    auditEvent(
      "offer.updated",
      {
        workspaceId: scope.workspaceId,
        actor: asAuditActor(actor),
        targetId: offer.id,
        details: { version, previousVersion: offer.version, changes },
      },
      ctx,
    ),
  ]);
}

/**
 * Archives an offer: it keeps its configuration and history but maps no access, so the queued
 * recompute ends its entitlements (`offer_archived`). Archiving an archived offer is a no-op.
 */
export async function archiveOffer(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  offerId: string,
): Promise<OfferResult> {
  const ctx = atOneInstant(context);
  const { scope, offer } = await openOffer(ctx, actor, slug, offerId);
  const current = summary(offer);
  if (offer.status === "archived") return { ok: true, offer: current, outboxId: null };
  return writeVersion(ctx, actor, offer, { config: current, status: "archived" }, (version) => [
    auditEvent(
      "offer.archived",
      {
        workspaceId: scope.workspaceId,
        actor: asAuditActor(actor),
        targetId: offer.id,
        details: { version },
      },
      ctx,
    ),
  ]);
}
