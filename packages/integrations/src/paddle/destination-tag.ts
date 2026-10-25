// How ShareRepo recognises the notification destinations it created in a seller's Paddle account
// (Phase 6 risk fixes, decision 0011 amendment). Paddle's notification settings carry no creation
// time and no owner, but they keep the `description` ShareRepo gives them (1–500 characters). Each
// destination ShareRepo creates is described with the workspace it belongs to and when it was
// created, so a sweep can find the ones no stored row names and delete only those: never another
// app's destination, and never another workspace's when one seller connects several.

/** The description of every destination created before the tag existed (Phase 5 and T5). */
export const LEGACY_DESTINATION_DESCRIPTION = "ShareRepo";

const TAG =
  /^ShareRepo workspace ([A-Za-z0-9_-]{1,128}) created (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export interface DestinationTag {
  /** The workspace whose connection the destination delivers to. */
  readonly workspaceId: string;
  /** When ShareRepo created it, epoch milliseconds. */
  readonly createdAt: number;
}

/** `ShareRepo workspace <workspaceId> created <ISO instant>`, shown in the Paddle dashboard. */
export function destinationDescription(tag: DestinationTag): string {
  return `ShareRepo workspace ${tag.workspaceId} created ${new Date(tag.createdAt).toISOString()}`;
}

/** The tag of a destination ShareRepo described, or null for any other description. */
export function parseDestinationDescription(description: string): DestinationTag | null {
  const match = TAG.exec(description);
  if (match === null) return null;
  const createdAt = Date.parse(match[2] as string);
  return Number.isNaN(createdAt) ? null : { workspaceId: match[1] as string, createdAt };
}
