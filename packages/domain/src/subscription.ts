import { z } from "zod";
import type { Instant } from "./time.ts";
import type { ParseResult } from "./workspace.ts";

/** Normalized commercial state of a subscription (product § policies, decision 0009). */
export const SUBSCRIPTION_STATES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "expired",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/**
 * The normalized commercial facts an entitlement source reports for one subscription. It is
 * commercial state only: it says nothing about repository access until policy decides.
 */
export interface SubscriptionSnapshot {
  readonly externalSubscriptionId: string;
  readonly externalCustomerId: string;
  /** The source's external item IDs, such as prices; unique. */
  readonly items: readonly string[];
  readonly state: SubscriptionState;
  /** The source's own state name, kept for display and diagnosis; policy never reads it. */
  readonly providerState: string;
  readonly currentPeriodStart: Instant | null;
  readonly currentPeriodEnd: Instant | null;
  /** Scheduled effective cancellation of a still-running subscription. */
  readonly cancelAt: Instant | null;
  /** Effective end; set exactly when the state is `canceled` or `expired`. */
  readonly endedAt: Instant | null;
  /** Start of the grace period; set exactly when the state is `past_due`. */
  readonly pastDueSince: Instant | null;
  /** The source's own timestamp for this snapshot. Orders snapshots; never the receipt time. */
  readonly sourceUpdatedAt: Instant;
}

const text = z.string().min(1);
const instant = z.number().int().nonnegative();

// Mirrors the CHECK constraints on `subscriptions` in packages/db; change both together.
const subscriptionSnapshotSchema = z
  .object({
    externalSubscriptionId: text,
    externalCustomerId: text,
    items: z.array(text),
    state: z.enum(SUBSCRIPTION_STATES),
    providerState: text,
    currentPeriodStart: instant.nullable(),
    currentPeriodEnd: instant.nullable(),
    cancelAt: instant.nullable(),
    endedAt: instant.nullable(),
    pastDueSince: instant.nullable(),
    sourceUpdatedAt: instant,
  })
  .refine((s) => new Set(s.items).size === s.items.length)
  .refine((s) => (s.state === "past_due") === (s.pastDueSince !== null))
  .refine((s) => (s.state === "canceled" || s.state === "expired") === (s.endedAt !== null))
  .refine(
    (s) =>
      s.currentPeriodStart === null ||
      s.currentPeriodEnd === null ||
      s.currentPeriodEnd > s.currentPeriodStart,
  );

/** Parses a snapshot from an entitlement source adapter, enforcing the stored invariants. */
export function parseSubscriptionSnapshot(
  value: unknown,
): ParseResult<SubscriptionSnapshot, "snapshot_invalid"> {
  const parsed = subscriptionSnapshotSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "snapshot_invalid" };
}

/**
 * Whether an incoming snapshot may replace the stored one: only when the source says it is
 * strictly newer. An equal timestamp is a duplicate and an older one is out of order; neither is
 * applied, so redelivery and reordering cannot regress newer state.
 */
export function isNewerSnapshot(
  stored: { readonly sourceUpdatedAt: Instant } | null,
  incoming: { readonly sourceUpdatedAt: Instant },
): boolean {
  return stored === null || incoming.sourceUpdatedAt > stored.sourceUpdatedAt;
}
