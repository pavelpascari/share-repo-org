import * as repo from "@sharerepo/db";
import {
  COMMERCIAL_SOURCES,
  type CommercialSource,
  type ParseResult,
  parseSubscriptionSnapshot,
  type SubscriptionSnapshot,
} from "@sharerepo/domain";
import { z } from "zod";

// The Phase 3 slice of the integrations doc's `EntitlementSource` (phase-3 plan § Entitlement
// source port). Paddle implements the same port in Phase 5.

/**
 * An explicit, verified link between a source's customer and a provider subject. Only the
 * simulator reports one in Phase 3 (decision 0009); Paddle reports null and the claim flow links.
 */
export interface CustomerLink {
  readonly provider: "github";
  /** The immutable GitHub user ID. */
  readonly externalSubjectId: string;
  /** A snapshot of the login when the link was made. */
  readonly login: string;
}

export type SourceSubscription =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly snapshot: SubscriptionSnapshot;
      readonly customerLink: CustomerLink | null;
    };

/** Reads the current commercial facts of one subscription from where they originate. */
export interface EntitlementSourcePort {
  readonly source: CommercialSource;
  refreshSubscription(ref: {
    readonly workspaceId: string;
    readonly externalSubscriptionId: string;
  }): Promise<SourceSubscription>;
}

/** Identifies one subscription in one source, within a workspace. */
export interface SubscriptionRef {
  readonly workspaceId: string;
  readonly source: CommercialSource;
  readonly externalSubscriptionId: string;
}

/**
 * The simulated source's view of its own row (decision 0009). Maps the row to a normalized
 * snapshot and validates it like any adapter's output. A row that breaks the snapshot invariants
 * is an internal error whose message carries no values.
 */
export function simulatedSnapshot(row: repo.SimulatedSubscription): SourceSubscription {
  let items: unknown;
  try {
    items = JSON.parse(row.items);
  } catch {
    items = null;
  }
  const parsed = parseSubscriptionSnapshot({
    externalSubscriptionId: row.id,
    externalCustomerId: `github:${row.customerGithubId}`,
    items,
    state: row.state,
    providerState: row.state,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAt: row.cancelAt,
    endedAt: row.endedAt,
    pastDueSince: row.pastDueSince,
    sourceUpdatedAt: row.updatedAt,
  });
  if (!parsed.ok) throw new Error("simulated subscription is not a valid snapshot");
  return {
    found: true,
    snapshot: parsed.value,
    customerLink: {
      provider: "github",
      externalSubjectId: row.customerGithubId,
      login: row.customerLogin,
    },
  };
}

/**
 * The simulated entitlement source, backed by `simulated_subscriptions`. Outside production only;
 * policy code never reads that table, processing reads it only through this port.
 */
export function simulatedEntitlementSource(db: repo.Db): EntitlementSourcePort {
  return {
    source: "simulated",
    async refreshSubscription(ref) {
      const row = await repo.getSimulatedSubscription(db, {
        workspaceId: ref.workspaceId,
        id: ref.externalSubscriptionId,
      });
      return row === null ? { found: false } : simulatedSnapshot(row);
    },
  };
}

// Outbox subject keys. Outbox rows carry IDs only (decision 0003); a key names the work, never
// its state. Workspace and offer IDs never contain `:`, so the first separators are unambiguous
// and an external subscription ID may contain any character.

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^:]+$/);
const refreshKeySchema = z.object({
  workspaceId: id,
  source: z.enum(COMMERCIAL_SOURCES),
  externalSubscriptionId: z.string().min(1),
});
const offerKeySchema = z.object({ workspaceId: id, offerId: id });

/** The `refresh_subscription` outbox subject: `<workspaceId>:<source>:<externalSubscriptionId>`. */
export function encodeRefreshKey(ref: SubscriptionRef): string {
  const parsed = refreshKeySchema.parse(ref);
  return `${parsed.workspaceId}:${parsed.source}:${parsed.externalSubscriptionId}`;
}

export function decodeRefreshKey(key: string): ParseResult<SubscriptionRef, "key_invalid"> {
  const [workspaceId, source, ...rest] = key.split(":");
  const parsed = refreshKeySchema.safeParse({
    workspaceId,
    source,
    externalSubscriptionId: rest.join(":"),
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "key_invalid" };
}

export interface OfferRef {
  readonly workspaceId: string;
  readonly offerId: string;
}

/** The `recompute_offer` outbox subject: `<workspaceId>:<offerId>`. */
export function encodeOfferKey(ref: OfferRef): string {
  const parsed = offerKeySchema.parse(ref);
  return `${parsed.workspaceId}:${parsed.offerId}`;
}

export function decodeOfferKey(key: string): ParseResult<OfferRef, "key_invalid"> {
  const parts = key.split(":");
  const parsed = offerKeySchema.safeParse({ workspaceId: parts[0], offerId: parts[1] });
  return parsed.success && parts.length === 2
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "key_invalid" };
}
