import { z } from "zod";
import type { ConnectionStatus } from "./connection.ts";
import type { ParseResult } from "./workspace.ts";

/** Something an access provider can grant access to. v1: GitHub repositories. */
export const RESOURCE_TYPES = ["repository"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Whether the resource is currently selected in its connection (installation). */
export const RESOURCE_SELECTIONS = ["selected", "removed"] as const;
export type ResourceSelection = (typeof RESOURCE_SELECTIONS)[number];

/**
 * What the provider can do for this resource, recorded explicitly rather than assumed
 * (architecture principle 9). Stored as a snapshot on each resource.
 */
export interface ResourceCapabilities {
  /** Whether a grant can be read-only. False means every grant gives write access. */
  readonly readOnlyGrant: boolean;
  readonly maxInvitationsPerDay: number;
  readonly invitationExpiryDays: number;
}

/** A repository owned by a personal GitHub account (decision 0008, research §§ 1 and 4). */
export const GITHUB_PERSONAL_REPOSITORY_CAPABILITIES: ResourceCapabilities = Object.freeze({
  readOnlyGrant: false,
  maxInvitationsPerDay: 50,
  invitationExpiryDays: 7,
});

const positiveInteger = z.number().int().positive();

// Not strict: a snapshot written by a newer version may carry capabilities this one ignores.
const capabilitiesSchema = z.object({
  readOnlyGrant: z.boolean(),
  maxInvitationsPerDay: positiveInteger,
  invitationExpiryDays: positiveInteger,
});

/** Parses a stored capability snapshot. */
export function parseResourceCapabilities(
  value: unknown,
): ParseResult<ResourceCapabilities, "capabilities_invalid"> {
  const parsed = capabilitiesSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "capabilities_invalid" };
}

/**
 * Whether access to the resource can be sold now: a private, unarchived repository that is still
 * selected in an active connection. Anything else blocks new provisioning.
 */
export function isSellable(
  resource: {
    readonly private: boolean;
    readonly archived: boolean;
    readonly selection: ResourceSelection;
  },
  connectionStatus: ConnectionStatus,
): boolean {
  return (
    resource.private &&
    !resource.archived &&
    resource.selection === "selected" &&
    connectionStatus === "active"
  );
}
