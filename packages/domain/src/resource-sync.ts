import type { ResourceSelection } from "./resource.ts";

/** A repository as the provider reports it now, keyed by its immutable ID. */
export interface ObservedRepository {
  readonly externalId: string;
  readonly name: string;
  readonly ownerExternalId: string;
  readonly private: boolean;
  readonly archived: boolean;
}

/** A stored resource, as last synced. */
export interface CurrentResource extends ObservedRepository {
  readonly id: string;
  readonly selection: ResourceSelection;
}

export interface Change<T> {
  readonly from: T;
  readonly to: T;
}

/** Fields that changed since the last sync; at least one is present. */
export interface ResourceChanges {
  readonly name?: Change<string>;
  readonly ownerExternalId?: Change<string>;
  readonly private?: Change<boolean>;
  readonly archived?: Change<boolean>;
}

export interface ResourceSyncPlan {
  /** Observed for the first time. */
  readonly discovered: readonly ObservedRepository[];
  readonly updated: readonly {
    readonly id: string;
    readonly externalId: string;
    readonly changes: ResourceChanges;
  }[];
  readonly selectionChanged: readonly {
    readonly id: string;
    readonly externalId: string;
    readonly from: ResourceSelection;
    readonly to: ResourceSelection;
  }[];
  /** Current resources that need no write. */
  readonly unchanged: number;
}

/**
 * Compares stored resources with what the provider reports now. The result depends only on the
 * two sets, not on their order or on how many events led here, so applying it is idempotent and
 * every list is sorted by external ID. Resources the provider no longer reports are marked
 * removed, never deleted: their identity and history stay for access reconciliation.
 */
export function planResourceSync(
  current: readonly CurrentResource[],
  observed: readonly ObservedRepository[],
): ResourceSyncPlan {
  const stored = byExternalId(current, "current resources");
  const seen = byExternalId(observed, "observed repositories");
  const discovered: ObservedRepository[] = [];
  const updated: ResourceSyncPlan["updated"][number][] = [];
  const selectionChanged: ResourceSyncPlan["selectionChanged"][number][] = [];
  let unchanged = 0;

  // Walking the sorted union of IDs once keeps every list in external-ID order. Each ID is in at
  // least one of the maps, so a missing resource means the repository exists, and vice versa.
  for (const externalId of [...new Set([...stored.keys(), ...seen.keys()])].sort()) {
    const resource = stored.get(externalId);
    const repository = seen.get(externalId);
    if (resource === undefined) {
      discovered.push(repository as ObservedRepository);
    } else if (repository === undefined) {
      if (resource.selection === "selected") {
        selectionChanged.push({ id: resource.id, externalId, from: "selected", to: "removed" });
      } else {
        unchanged += 1;
      }
    } else {
      const changes = changesBetween(resource, repository);
      if (changes !== null) updated.push({ id: resource.id, externalId, changes });
      if (resource.selection === "removed") {
        selectionChanged.push({ id: resource.id, externalId, from: "removed", to: "selected" });
      } else if (changes === null) {
        unchanged += 1;
      }
    }
  }

  return { discovered, updated, selectionChanged, unchanged };
}

function byExternalId<T extends { readonly externalId: string }>(
  items: readonly T[],
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.externalId)) throw new Error(`duplicate external ID in ${label}`);
    map.set(item.externalId, item);
  }
  return map;
}

function changesBetween(
  resource: ObservedRepository,
  repository: ObservedRepository,
): ResourceChanges | null {
  const changes: {
    name?: Change<string>;
    ownerExternalId?: Change<string>;
    private?: Change<boolean>;
    archived?: Change<boolean>;
  } = {};
  if (resource.name !== repository.name) {
    changes.name = { from: resource.name, to: repository.name };
  }
  if (resource.ownerExternalId !== repository.ownerExternalId) {
    changes.ownerExternalId = { from: resource.ownerExternalId, to: repository.ownerExternalId };
  }
  if (resource.private !== repository.private) {
    changes.private = { from: resource.private, to: repository.private };
  }
  if (resource.archived !== repository.archived) {
    changes.archived = { from: resource.archived, to: repository.archived };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
