import { z } from "zod";
import type { ConnectionStatus } from "./connection.ts";
import { ACCESS_LEVELS, type AccessLevel, supportsAccessLevel } from "./entitlement.ts";
import { isSellable, type ResourceCapabilities, type ResourceSelection } from "./resource.ts";
import type { ParseResult } from "./workspace.ts";

/** Whether an offer can be sold. Archived offers keep their history but map no new access. */
export const OFFER_STATUSES = ["active", "archived"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Bounds for the creator-set past-due grace period, in days (decision 0009). */
export const GRACE_PERIOD_DAYS_MIN = 0;
export const GRACE_PERIOD_DAYS_MAX = 30;
export const GRACE_PERIOD_DAYS_DEFAULT = 7;

/**
 * Where commercial facts come from. `simulated` stands in for a provider outside production
 * (decision 0009); `paddle` is reserved for Phase 5 so the stored CHECK need not change then.
 */
export const COMMERCIAL_SOURCES = ["simulated", "paddle"] as const;
export type CommercialSource = (typeof COMMERCIAL_SOURCES)[number];

/** Counted in Unicode code points, like workspace names. */
export const OFFER_NAME_MAX_LENGTH = 100;
/** Upper bounds that keep one offer's writes within a single database batch. */
export const OFFER_ITEMS_MAX = 100;
export const OFFER_ACCESSES_MAX = 100;

/** A commercial item, such as a price, that maps a subscription to this offer. */
export interface OfferItem {
  readonly source: CommercialSource;
  readonly externalItemId: string;
}

/** A repository the offer sells, and the access level it gives. */
export interface OfferAccess {
  readonly resourceId: string;
  readonly accessLevel: AccessLevel;
}

/**
 * A validated offer configuration. Items are sorted by source then external ID, and accesses by
 * resource ID, so equal configurations compare equal.
 */
export interface OfferInput {
  readonly name: string;
  readonly gracePeriodDays: number;
  readonly items: readonly OfferItem[];
  readonly accesses: readonly OfferAccess[];
}

/** What `offer_versions.snapshot` stores: the configuration at one version. */
export type OfferSnapshot = OfferInput;

/**
 * Why an offer configuration was refused. Codes name the field, never the value:
 * - `input_invalid`: not an object;
 * - `name_invalid`: empty after trimming, or longer than {@link OFFER_NAME_MAX_LENGTH};
 * - `grace_period_invalid`: not an integer number of days within the bounds;
 * - `items_invalid`: not a list, or longer than {@link OFFER_ITEMS_MAX};
 * - `item_invalid`: an unknown source or a malformed external item ID;
 * - `item_duplicate`: the same source and external item ID twice;
 * - `accesses_invalid`: not a list, or longer than {@link OFFER_ACCESSES_MAX};
 * - `access_invalid`: an access without a resource ID;
 * - `access_level_invalid`: an unknown access level;
 * - `access_required`: no access at all;
 * - `access_duplicate`: the same resource twice.
 */
export type OfferInputError =
  | "input_invalid"
  | "name_invalid"
  | "grace_period_invalid"
  | "items_invalid"
  | "item_invalid"
  | "item_duplicate"
  | "accesses_invalid"
  | "access_invalid"
  | "access_level_invalid"
  | "access_required"
  | "access_duplicate";

/** Provider item IDs such as Paddle's `pri_01h…`: ASCII letters, digits and `_ . : -`. */
const EXTERNAL_ITEM_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const gracePeriodSchema = z.number().int().min(GRACE_PERIOD_DAYS_MIN).max(GRACE_PERIOD_DAYS_MAX);
const itemSchema = z.object({
  source: z.enum(COMMERCIAL_SOURCES),
  externalItemId: z.string().regex(EXTERNAL_ITEM_ID),
});
const resourceRefSchema = z.object({ resourceId: z.string().min(1) });
const accessSchema = resourceRefSchema.extend({ accessLevel: z.enum(ACCESS_LEVELS) });

/**
 * Parses an offer configuration from untrusted input. The name is trimmed of surrounding Unicode
 * whitespace; an absent grace period takes {@link GRACE_PERIOD_DAYS_DEFAULT}. Items may be empty
 * (the offer is then not yet sold), but an offer must give access to at least one repository.
 */
export function parseOfferInput(raw: unknown): ParseResult<OfferInput, OfferInputError> {
  if (typeof raw !== "object" || raw === null) return fail("input_invalid");
  const input = raw as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "" || [...name].length > OFFER_NAME_MAX_LENGTH) return fail("name_invalid");

  const gracePeriod = gracePeriodSchema.safeParse(
    input.gracePeriodDays === undefined ? GRACE_PERIOD_DAYS_DEFAULT : input.gracePeriodDays,
  );
  if (!gracePeriod.success) return fail("grace_period_invalid");

  if (!Array.isArray(input.items) || input.items.length > OFFER_ITEMS_MAX) {
    return fail("items_invalid");
  }
  const items = new Map<string, OfferItem>();
  for (const value of input.items) {
    const item = itemSchema.safeParse(value);
    if (!item.success) return fail("item_invalid");
    const key = sortKey(item.data.source, item.data.externalItemId);
    if (items.has(key)) return fail("item_duplicate");
    items.set(key, item.data);
  }

  if (!Array.isArray(input.accesses) || input.accesses.length > OFFER_ACCESSES_MAX) {
    return fail("accesses_invalid");
  }
  if (input.accesses.length === 0) return fail("access_required");
  const accesses = new Map<string, OfferAccess>();
  for (const value of input.accesses) {
    const access = accessSchema.safeParse(value);
    if (!access.success) {
      const hasResource = resourceRefSchema.safeParse(value).success;
      return fail(hasResource ? "access_level_invalid" : "access_invalid");
    }
    if (accesses.has(access.data.resourceId)) return fail("access_duplicate");
    accesses.set(access.data.resourceId, access.data);
  }

  return {
    ok: true,
    value: {
      name,
      gracePeriodDays: gracePeriod.data,
      items: sortedValues(items),
      accesses: sortedValues(accesses),
    },
  };
}

// Not strict: a snapshot written by a newer version may carry keys this one ignores.
const offerSnapshotSchema = z.object({
  name: z.string().min(1),
  gracePeriodDays: gracePeriodSchema,
  items: z.array(itemSchema),
  accesses: z.array(accessSchema).min(1),
});

/** Parses a stored `offer_versions.snapshot`. */
export function parseOfferSnapshot(value: unknown): ParseResult<OfferSnapshot, "snapshot_invalid"> {
  const parsed = offerSnapshotSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "snapshot_invalid" };
}

/**
 * Why an access cannot be part of an offer:
 * - `resource_not_found`: no such resource in the workspace;
 * - `resource_not_sellable`: newly added, but not sellable now ({@link isSellable});
 * - `access_level_unsupported`: the resource's capabilities cannot grant the level.
 */
export type OfferAccessError =
  | "resource_not_found"
  | "resource_not_sellable"
  | "access_level_unsupported";

/** A resource as offer validation needs it, with its connection's status. */
export interface OfferResource {
  readonly id: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly selection: ResourceSelection;
  readonly capabilities: Pick<ResourceCapabilities, "readOnlyGrant">;
  readonly connectionStatus: ConnectionStatus;
}

/**
 * Checks parsed accesses against the workspace's resources and returns one problem per refused
 * access, in input order. Only sellable resources can be added, but a resource that was already
 * in the offer (`previousResourceIds`) may stay after it stops being sellable; reconciliation
 * then blocks provisioning for it instead.
 */
export function checkOfferAccesses(
  accesses: readonly OfferAccess[],
  context: {
    readonly resources: readonly OfferResource[];
    readonly previousResourceIds: readonly string[];
  },
): { readonly resourceId: string; readonly error: OfferAccessError }[] {
  const resources = new Map(context.resources.map((resource) => [resource.id, resource]));
  const previous = new Set(context.previousResourceIds);
  return accesses.flatMap(({ resourceId, accessLevel }) => {
    const error = accessError(resources.get(resourceId), previous.has(resourceId), accessLevel);
    return error === null ? [] : [{ resourceId, error }];
  });
}

function accessError(
  resource: OfferResource | undefined,
  alreadyOffered: boolean,
  accessLevel: AccessLevel,
): OfferAccessError | null {
  if (resource === undefined) return "resource_not_found";
  if (!alreadyOffered && !isSellable(resource, resource.connectionStatus)) {
    return "resource_not_sellable";
  }
  if (!supportsAccessLevel(resource.capabilities, accessLevel)) return "access_level_unsupported";
  return null;
}

function fail(error: OfferInputError): { readonly ok: false; readonly error: OfferInputError } {
  return { ok: false, error };
}

/**
 * An unambiguous key whose string order is tuple order: every character a source or item ID may
 * contain sorts after the closing quote.
 */
function sortKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function sortedValues<T>(map: ReadonlyMap<string, T>): T[] {
  return [...map.keys()].sort().map((key) => map.get(key) as T);
}
