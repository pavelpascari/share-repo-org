import { describe, expect, it } from "vitest";
import {
  ACCESS_DECISION_REASONS,
  ACCESS_POLICY_VERSION,
  accountDeletionConfirmed,
  EXPORT_RATE_LIMIT,
  exportRateLimitBuckets,
  isBeingDeleted,
  LIFECYCLE_BATCH_SIZE,
  type LiveEntitlement,
  PurgeBlock,
  planEntitlements,
  pruneCutoffs,
  purgeBlock,
  purgeDue,
  RETENTION_MS,
  WORKSPACE_DELETION_DELAY_MS,
  WORKSPACE_EXPORT_FORMAT_VERSION,
  WORKSPACE_STATUSES,
  workspaceDeletionConfirmed,
  workspacesBlockingAccountDeletion,
  workspaceWithdrawal,
} from "../src/index.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe("retention (decision 0015)", () => {
  it("keeps each kind of data for its documented period", () => {
    expect(RETENTION_MS).toEqual({
      externalEvents: 30 * DAY,
      sentOutbox: 7 * DAY,
      dismissedOutbox: 90 * DAY,
      claims: 30 * DAY,
      settledMutations: 90 * DAY,
      expiredAuth: 7 * DAY,
      rateLimitCounters: DAY,
      orphanedUsers: DAY,
    });
    expect(LIFECYCLE_BATCH_SIZE).toBe(500);
  });

  it("prunes what ended before each period, counted back from now", () => {
    expect(pruneCutoffs(NOW)).toEqual({
      externalEventsReceivedBefore: NOW - 30 * DAY,
      outboxSentBefore: NOW - 7 * DAY,
      outboxDismissedBefore: NOW - 90 * DAY,
      claimsEndedBefore: NOW - 30 * DAY,
      mutationsFinishedBefore: NOW - 90 * DAY,
      authExpiredBefore: NOW - 7 * DAY,
      rateLimitWindowStartedBefore: NOW - DAY,
      orphanedUsersCreatedBefore: NOW - DAY,
    });
  });
});

describe("workspace deletion", () => {
  it("waits 30 days before a purge", () => {
    expect(WORKSPACE_DELETION_DELAY_MS).toBe(30 * DAY);
  });

  it("is confirmed only by the exact slug, ignoring surrounding spaces", () => {
    expect(workspaceDeletionConfirmed("acme", "acme")).toBe(true);
    expect(workspaceDeletionConfirmed("acme", "  acme ")).toBe(true);
    expect(workspaceDeletionConfirmed("acme", "ACME")).toBe(false);
    expect(workspaceDeletionConfirmed("acme", "acm")).toBe(false);
    expect(workspaceDeletionConfirmed("acme", "")).toBe(false);
  });

  it("is under way while deleting or purging", () => {
    expect(WORKSPACE_STATUSES.filter(isBeingDeleted)).toEqual(["deleting", "purging"]);
  });

  it("withdraws all access while the workspace is being deleted", () => {
    expect(WORKSPACE_STATUSES.map(workspaceWithdrawal)).toEqual([
      null,
      null,
      "workspace_deleted",
      "workspace_deleted",
    ]);
  });

  it("purges only a workspace being deleted whose delete_after has passed", () => {
    expect(purgeDue({ status: "deleting", deleteAfter: NOW }, NOW)).toBe(true);
    expect(purgeDue({ status: "purging", deleteAfter: NOW - 1 }, NOW)).toBe(true);
    expect(purgeDue({ status: "deleting", deleteAfter: NOW + 1 }, NOW)).toBe(false);
    expect(purgeDue({ status: "deleting", deleteAfter: null }, NOW)).toBe(false);
    expect(purgeDue({ status: "active", deleteAfter: NOW - 1 }, NOW)).toBe(false);
    expect(purgeDue({ status: "suspended", deleteAfter: NOW - 1 }, NOW)).toBe(false);
  });

  it("waits for live entitlements first, then for managed access", () => {
    expect(PurgeBlock).toEqual({
      EntitlementsRemaining: "entitlements_remaining",
      ManagedAccessRemaining: "managed_access_remaining",
    });
    expect(purgeBlock({ liveEntitlements: 0, managedGrants: 0 })).toBeNull();
    expect(purgeBlock({ liveEntitlements: 1, managedGrants: 0 })).toBe("entitlements_remaining");
    expect(purgeBlock({ liveEntitlements: 2, managedGrants: 3 })).toBe("entitlements_remaining");
    expect(purgeBlock({ liveEntitlements: 0, managedGrants: 1 })).toBe("managed_access_remaining");
  });
});

describe("account deletion", () => {
  it("is confirmed by the GitHub login, in any case", () => {
    expect(accountDeletionConfirmed("Mona", "Mona")).toBe(true);
    expect(accountDeletionConfirmed("Mona", " mona ")).toBe(true);
    expect(accountDeletionConfirmed("mona", "MONA")).toBe(true);
    expect(accountDeletionConfirmed("mona", "monalisa")).toBe(false);
    expect(accountDeletionConfirmed("mona", "")).toBe(false);
  });

  it("is blocked by every owned workspace that is not being deleted", () => {
    const memberships = [
      { slug: "a", role: "owner", status: "active" },
      { slug: "b", role: "owner", status: "suspended" },
      { slug: "c", role: "owner", status: "deleting" },
      { slug: "d", role: "owner", status: "purging" },
      { slug: "e", role: "member", status: "active" },
    ] as const;
    expect(workspacesBlockingAccountDeletion(memberships).map((m) => m.slug)).toEqual(["a", "b"]);
    expect(workspacesBlockingAccountDeletion([])).toEqual([]);
  });
});

describe("workspace export", () => {
  it("is format version 2, limited to 5 an hour per workspace", () => {
    expect(WORKSPACE_EXPORT_FORMAT_VERSION).toBe(2);
    expect(EXPORT_RATE_LIMIT).toEqual({ windowMs: HOUR, limit: 5 });
    expect(exportRateLimitBuckets("w1")).toEqual([
      { bucket: "export:w1:h", windowMs: HOUR, limit: 5, retired: [] },
    ]);
  });
});

describe("planEntitlements with access withdrawn (decision 0015)", () => {
  const live = (id: string, overrides: Partial<LiveEntitlement> = {}): LiveEntitlement => ({
    id,
    offerId: "o1",
    offerVersion: 1,
    resourceId: "r1",
    subjectId: "s1",
    accessLevel: "write",
    validFrom: NOW - DAY,
    validUntil: null,
    decisionReason: "active",
    policyVersion: ACCESS_POLICY_VERSION,
    ...overrides,
  });
  const input = {
    now: NOW,
    subscription: {
      id: "sub1",
      state: "active",
      cancelAt: NOW + DAY,
      endedAt: null,
      pastDueSince: null,
      items: ["item"],
    },
    subjectId: "s1",
    offers: [
      {
        offerId: "o1",
        version: 1,
        status: "active",
        gracePeriodDays: 7,
        items: ["item"],
        accesses: [
          { resourceId: "r1", accessLevel: "write" },
          { resourceId: "r2", accessLevel: "read" },
        ],
      },
    ],
  } as const;

  it("revokes every live entitlement with the withdrawal's reason and creates none", () => {
    for (const withdrawn of ["workspace_deleted", "account_deleted"] as const) {
      expect(planEntitlements({ ...input, live: [live("e1")], withdrawn })).toEqual({
        create: [],
        update: [],
        end: [{ id: "e1", state: "revoked", reason: withdrawn }],
        nextEvaluationAt: null,
      });
    }
  });

  it("revokes even when the subscription is gone", () => {
    expect(
      planEntitlements({
        ...input,
        subscription: null,
        live: [live("e1")],
        withdrawn: "workspace_deleted",
      }).end,
    ).toEqual([{ id: "e1", state: "revoked", reason: "workspace_deleted" }]);
  });

  it("still ends a lapsed entitlement as expired, by its own boundary", () => {
    const lapsed = live("e1", { validUntil: NOW, decisionReason: "cancel_scheduled" });
    expect(
      planEntitlements({ ...input, live: [lapsed], withdrawn: "workspace_deleted" }).end,
    ).toEqual([{ id: "e1", state: "expired", reason: "cancellation_effective" }]);
  });

  it("plans as before without a withdrawal", () => {
    const plain = planEntitlements({ ...input, live: [live("e1")] });
    expect(planEntitlements({ ...input, live: [live("e1")], withdrawn: null })).toEqual(plain);
    expect(plain.end).toEqual([]);
    expect(plain.create.map((e) => e.resourceId)).toEqual(["r2"]);
    expect(plain.nextEvaluationAt).toBe(NOW + DAY);
  });

  it("are decision reasons", () => {
    expect(ACCESS_DECISION_REASONS).toContain("workspace_deleted");
    expect(ACCESS_DECISION_REASONS).toContain("account_deleted");
  });
});
