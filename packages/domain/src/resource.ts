/** Something an access provider can grant access to. v1: GitHub repositories. */
export const RESOURCE_TYPES = ["repository"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Whether the resource is currently selected in its connection (installation). */
export const RESOURCE_SELECTIONS = ["selected", "removed"] as const;
export type ResourceSelection = (typeof RESOURCE_SELECTIONS)[number];
