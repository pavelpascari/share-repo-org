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
      /**
       * The checkout claim reference the source carried (Paddle's `custom_data.sharerepo_claim`),
       * untrusted until the refresh verifies it (decision 0012, path 1). Null when there is none.
       */
      readonly claimReference: string | null;
    };

/** Reads the current commercial facts of one subscription from where they originate. */
export interface EntitlementSourcePort {
  readonly source: CommercialSource;
  /**
   * The key that verifies the claim references this source reports (`CLAIM_SIGNING_KEY`). Absent
   * for a source that reports none, such as the simulator.
   */
  readonly claimSigningKey?: Uint8Array;
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
    claimReference: null,
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

/** Identifies one resource to reconcile, within a workspace. */
export interface ReconcileRef {
  readonly workspaceId: string;
  readonly resourceId: string;
}

const reconcileKeySchema = z.object({ workspaceId: id, resourceId: id });

/** The `reconcile_resource` outbox subject: `<workspaceId>:<resourceId>`, as db `reconcileKey`. */
export function encodeReconcileKey(ref: ReconcileRef): string {
  const parsed = reconcileKeySchema.parse(ref);
  return `${parsed.workspaceId}:${parsed.resourceId}`;
}

export function decodeReconcileKey(key: string): ParseResult<ReconcileRef, "key_invalid"> {
  const parts = key.split(":");
  const parsed = reconcileKeySchema.safeParse({ workspaceId: parts[0], resourceId: parts[1] });
  return parsed.success && parts.length === 2
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "key_invalid" };
}

/** Identifies one Paddle connection, within its workspace. */
export interface PaddleConnectionRef {
  readonly workspaceId: string;
  readonly connectionId: string;
}

/** Identifies one claim request (decision 0012, path 2), within its workspace. */
export interface ClaimRequestRef {
  readonly workspaceId: string;
  readonly claimRequestId: string;
}

const pairKeySchema = z.object({ workspaceId: id, id });

function encodePair(workspaceId: string, value: string): string {
  const parsed = pairKeySchema.parse({ workspaceId, id: value });
  return `${parsed.workspaceId}:${parsed.id}`;
}

function decodePair(key: string): { workspaceId: string; id: string } | null {
  const parts = key.split(":");
  const parsed = pairKeySchema.safeParse({ workspaceId: parts[0], id: parts[1] });
  return parsed.success && parts.length === 2 ? parsed.data : null;
}

/**
 * The `check_paddle_connection` and `sweep_paddle_subscriptions` outbox subject:
 * `<workspaceId>:<connectionId>`.
 */
export function encodePaddleConnectionKey(ref: PaddleConnectionRef): string {
  return encodePair(ref.workspaceId, ref.connectionId);
}

export function decodePaddleConnectionKey(
  key: string,
): ParseResult<PaddleConnectionRef, "key_invalid"> {
  const pair = decodePair(key);
  return pair === null
    ? { ok: false, error: "key_invalid" }
    : { ok: true, value: { workspaceId: pair.workspaceId, connectionId: pair.id } };
}

/** The `send_claim_email` outbox subject: `<workspaceId>:<claimRequestId>`. */
export function encodeClaimRequestKey(ref: ClaimRequestRef): string {
  return encodePair(ref.workspaceId, ref.claimRequestId);
}

export function decodeClaimRequestKey(key: string): ParseResult<ClaimRequestRef, "key_invalid"> {
  const pair = decodePair(key);
  return pair === null
    ? { ok: false, error: "key_invalid" }
    : { ok: true, value: { workspaceId: pair.workspaceId, claimRequestId: pair.id } };
}
