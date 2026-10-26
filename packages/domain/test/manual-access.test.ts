import { describe, expect, it } from "vitest";
import {
  ACCESS_POLICY_VERSION,
  decideManualAccess,
  type LiveEntitlement,
  type ManualPlanInput,
  manualAccessEndDate,
  manualAccessRateLimitBuckets,
  manualAccessStatus,
  type PlanManualAccess,
  type PlanManualOffer,
  parseManualAccessEnd,
  parseManualAccessEndDate,
  parseManualAccessNote,
  planManualEntitlements,
} from "../src/index.ts";

// Manual access (decision 0016). Every expectation is a literal.

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
/** The expiry confirmation window, 6 hours (decision 0013). */
const WINDOW = 6 * 60 * 60 * 1000;

const access = (overrides: Partial<PlanManualAccess> = {}): PlanManualAccess => ({
  id: "ma1",
  offerId: "o1",
  subjectId: "s1",
  endsAt: null,
  revokedAt: null,
  ...overrides,
});

const offer = (overrides: Partial<PlanManualOffer> = {}): PlanManualOffer => ({
  offerId: "o1",
  version: 2,
  status: "active",
  accesses: [{ resourceId: "r1", accessLevel: "write" }],
  ...overrides,
});

const live = (id: string, overrides: Partial<LiveEntitlement> = {}): LiveEntitlement => ({
  id,
  offerId: "o1",
  offerVersion: 2,
  resourceId: "r1",
  subjectId: "s1",
  accessLevel: "write",
  validFrom: NOW - DAY,
  validUntil: null,
  decisionReason: "manual",
  policyVersion: ACCESS_POLICY_VERSION,
  ...overrides,
});

const plan = (overrides: Partial<ManualPlanInput> = {}) =>
  planManualEntitlements({ now: NOW, access: access(), offer: offer(), live: [], ...overrides });

describe("manualAccessStatus", () => {
  it.each([
    [{ endsAt: null, revokedAt: null }, "active"],
    [{ endsAt: NOW + 1, revokedAt: null }, "active"],
    [{ endsAt: NOW, revokedAt: null }, "ended"],
    [{ endsAt: NOW - 1, revokedAt: null }, "ended"],
    [{ endsAt: null, revokedAt: NOW - DAY }, "revoked"],
    [{ endsAt: NOW - 1, revokedAt: NOW - DAY }, "revoked"],
  ] as const)("%j is %s", (terms, status) => {
    expect(manualAccessStatus(terms, NOW)).toBe(status);
  });
});

describe("parseManualAccessNote", () => {
  it.each([
    ["", { ok: true, value: null }],
    ["   ", { ok: true, value: null }],
    ["  early buyer, paid by invoice ", { ok: true, value: "early buyer, paid by invoice" }],
    ["a".repeat(500), { ok: true, value: "a".repeat(500) }],
    ["😀".repeat(500), { ok: true, value: "😀".repeat(500) }],
    ["a".repeat(501), { ok: false, error: "note_too_long" }],
    ["line\nbreak", { ok: false, error: "note_invalid_characters" }],
    ["tab\there", { ok: false, error: "note_invalid_characters" }],
  ])("%j", (input, result) => {
    expect(parseManualAccessNote(input)).toEqual(result);
  });
});

// Decision 0017: the end of the chosen date anywhere on Earth (UTC−12) is 12:00 UTC next day.
describe("parseManualAccessEndDate", () => {
  it.each([
    ["", { ok: true, value: null }],
    ["  ", { ok: true, value: null }],
    ["2026-10-26", { ok: true, value: Date.UTC(2026, 9, 27, 12) }],
    [" 2026-12-31 ", { ok: true, value: Date.UTC(2027, 0, 1, 12) }],
    ["2026-13-01", { ok: false, error: "end_date_invalid" }],
    ["26/10/2026", { ok: false, error: "end_date_invalid" }],
    ["2026-10-26T00:00", { ok: false, error: "end_date_invalid" }],
    ["x2026-10-26", { ok: false, error: "end_date_invalid" }],
    ["2026-02-30", { ok: false, error: "end_date_invalid" }],
    ["+002026-10-26", { ok: false, error: "end_date_invalid" }],
  ])("%j", (input, result) => {
    expect(parseManualAccessEndDate(input)).toEqual(result);
  });

  it.each([
    [Date.UTC(2026, 9, 27, 12), "2026-10-26"],
    [Date.UTC(2027, 0, 1, 12), "2026-12-31"],
  ])("the end %d was chosen as %s", (endsAt, date) => {
    expect(manualAccessEndDate(endsAt)).toBe(date);
  });
});

describe("parseManualAccessEnd", () => {
  it.each([
    [null, { ok: true, value: null }],
    [NOW + 1, { ok: true, value: NOW + 1 }],
    [NOW, { ok: false, error: "end_not_in_future" }],
    [NOW - 1, { ok: false, error: "end_not_in_future" }],
  ])("%j", (endsAt, result) => {
    expect(parseManualAccessEnd(endsAt, NOW)).toEqual(result);
  });
});

describe("decideManualAccess", () => {
  it("grants open-ended access without an end date", () => {
    expect(decideManualAccess({ endsAt: null, revokedAt: null }, NOW)).toEqual({
      granted: true,
      validUntil: null,
      reason: "manual",
      nextEvaluationAt: null,
    });
  });

  it("grants access until a future end date, and evaluates again then", () => {
    expect(decideManualAccess({ endsAt: NOW + DAY, revokedAt: null }, NOW)).toEqual({
      granted: true,
      validUntil: NOW + DAY,
      reason: "manual",
      nextEvaluationAt: NOW + DAY,
    });
  });

  it.each([NOW, NOW - 1])("ends access once the end date %d has passed", (endsAt) => {
    expect(decideManualAccess({ endsAt, revokedAt: null }, NOW)).toEqual({
      granted: false,
      validUntil: null,
      reason: "manual_ended",
      nextEvaluationAt: null,
    });
  });

  it("revokes, whatever the end date", () => {
    expect(decideManualAccess({ endsAt: NOW + DAY, revokedAt: NOW - 1 }, NOW)).toEqual({
      granted: false,
      validUntil: null,
      reason: "manual_revoked",
      nextEvaluationAt: null,
    });
  });
});

describe("planManualEntitlements", () => {
  it("creates one entitlement per repository of the offer, at its current version", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY }),
        offer: offer({
          accesses: [
            { resourceId: "r2", accessLevel: "read" },
            { resourceId: "r1", accessLevel: "write" },
          ],
        }),
      }),
    ).toEqual({
      create: [
        {
          offerId: "o1",
          offerVersion: 2,
          resourceId: "r1",
          subjectId: "s1",
          accessLevel: "write",
          validFrom: NOW,
          validUntil: NOW + DAY,
          decisionReason: "manual",
          policyVersion: ACCESS_POLICY_VERSION,
        },
        {
          offerId: "o1",
          offerVersion: 2,
          resourceId: "r2",
          subjectId: "s1",
          accessLevel: "read",
          validFrom: NOW,
          validUntil: NOW + DAY,
          decisionReason: "manual",
          policyVersion: ACCESS_POLICY_VERSION,
        },
      ],
      update: [],
      end: [],
      nextEvaluationAt: NOW + DAY,
    });
  });

  it("is empty when the live entitlements already match", () => {
    expect(plan({ live: [live("e1")] })).toEqual({
      create: [],
      update: [],
      end: [],
      nextEvaluationAt: null,
    });
  });

  it("follows the offer's new version and a changed end date", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY }),
        offer: offer({ version: 3 }),
        live: [live("e1")],
      }),
    ).toEqual({
      create: [],
      update: [
        {
          id: "e1",
          set: {
            validUntil: NOW + DAY,
            decisionReason: "manual",
            offerVersion: 3,
            policyVersion: ACCESS_POLICY_VERSION,
          },
        },
      ],
      end: [],
      nextEvaluationAt: NOW + DAY,
    });
  });

  it("revokes a repository the offer no longer lists, and grants one it now lists", () => {
    expect(
      plan({
        offer: offer({ version: 3, accesses: [{ resourceId: "r2", accessLevel: "write" }] }),
        live: [live("e1")],
      }),
    ).toEqual({
      create: [
        {
          offerId: "o1",
          offerVersion: 3,
          resourceId: "r2",
          subjectId: "s1",
          accessLevel: "write",
          validFrom: NOW,
          validUntil: null,
          decisionReason: "manual",
          policyVersion: ACCESS_POLICY_VERSION,
        },
      ],
      update: [],
      end: [{ id: "e1", state: "revoked", reason: "offer_access_removed" }],
      nextEvaluationAt: null,
    });
  });

  it("replaces an entitlement whose access level changed", () => {
    expect(
      plan({
        offer: offer({ version: 3, accesses: [{ resourceId: "r1", accessLevel: "read" }] }),
        live: [live("e1")],
      }),
    ).toEqual({
      create: [
        {
          offerId: "o1",
          offerVersion: 3,
          resourceId: "r1",
          subjectId: "s1",
          accessLevel: "read",
          validFrom: NOW,
          validUntil: null,
          decisionReason: "manual",
          policyVersion: ACCESS_POLICY_VERSION,
        },
      ],
      update: [],
      end: [{ id: "e1", state: "revoked", reason: "offer_access_changed" }],
      nextEvaluationAt: null,
    });
  });

  it("revokes every entitlement of a revoked access", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY, revokedAt: NOW }),
        live: [live("e1", { validUntil: NOW + DAY })],
      }),
    ).toEqual({
      create: [],
      update: [],
      end: [{ id: "e1", state: "revoked", reason: "manual_revoked" }],
      nextEvaluationAt: null,
    });
  });

  it("names the revocation, not the archive, when a revoked access's offer is archived", () => {
    expect(
      plan({
        access: access({ revokedAt: NOW }),
        offer: offer({ status: "archived" }),
        live: [live("e1")],
      }),
    ).toEqual({
      create: [],
      update: [],
      end: [{ id: "e1", state: "revoked", reason: "manual_revoked" }],
      nextEvaluationAt: null,
    });
  });

  it("revokes every entitlement when the offer is archived", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY }),
        offer: offer({ status: "archived" }),
        live: [live("e1")],
      }),
    ).toEqual({
      create: [],
      update: [],
      end: [{ id: "e1", state: "revoked", reason: "offer_archived" }],
      nextEvaluationAt: null,
    });
  });

  it("withdraws everything while the workspace is being deleted, and creates nothing", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY }),
        live: [live("e1", { validUntil: NOW + DAY })],
        withdrawn: "workspace_deleted",
      }),
    ).toEqual({
      create: [],
      update: [],
      end: [{ id: "e1", state: "revoked", reason: "workspace_deleted" }],
      nextEvaluationAt: null,
    });
    expect(plan({ withdrawn: "workspace_deleted" })).toEqual({
      create: [],
      update: [],
      end: [],
      nextEvaluationAt: null,
    });
  });

  it("expires entitlements once the end date has passed, at the sweep", () => {
    expect(
      plan({
        access: access({ endsAt: NOW - 1 }),
        live: [live("e1", { validUntil: NOW - 1 })],
      }),
    ).toEqual({
      create: [],
      update: [],
      end: [{ id: "e1", state: "expired", reason: "manual_ended" }],
      nextEvaluationAt: null,
    });
  });

  it("expires a lapsed entitlement as manual_ended after the confirmation window too", () => {
    expect(
      plan({
        access: access({ endsAt: NOW - WINDOW, revokedAt: null }),
        offer: offer({ status: "archived" }),
        live: [live("e1", { validUntil: NOW - WINDOW })],
      }),
    ).toEqual({
      create: [],
      update: [],
      end: [{ id: "e1", state: "expired", reason: "manual_ended" }],
      nextEvaluationAt: null,
    });
  });

  it("continues an entitlement whose end date was extended while its expiry was pending", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY }),
        live: [live("e1", { validUntil: NOW - 1 })],
      }),
    ).toEqual({
      create: [],
      update: [
        {
          id: "e1",
          set: {
            validUntil: NOW + DAY,
            decisionReason: "manual",
            offerVersion: 2,
            policyVersion: ACCESS_POLICY_VERSION,
          },
        },
      ],
      end: [],
      nextEvaluationAt: NOW + DAY,
    });
  });

  it("grants again with a new row after an ended access is extended past the window", () => {
    expect(
      plan({
        access: access({ endsAt: NOW + DAY }),
        live: [live("e1", { validUntil: NOW - WINDOW })],
      }),
    ).toEqual({
      create: [
        {
          offerId: "o1",
          offerVersion: 2,
          resourceId: "r1",
          subjectId: "s1",
          accessLevel: "write",
          validFrom: NOW,
          validUntil: NOW + DAY,
          decisionReason: "manual",
          policyVersion: ACCESS_POLICY_VERSION,
        },
      ],
      update: [],
      end: [{ id: "e1", state: "expired", reason: "manual_ended" }],
      nextEvaluationAt: NOW + DAY,
    });
  });

  it("refuses an offer that is not the access's", () => {
    expect(() => plan({ offer: offer({ offerId: "o2" }) })).toThrow(
      "offer is not the manual access's offer",
    );
  });

  it.each([
    ["offer", { offerId: "o2" }],
    ["subject", { subjectId: "s2" }],
  ])("refuses a live entitlement of another %s", (_, overrides) => {
    expect(() => plan({ live: [live("e1", overrides)] })).toThrow(
      "live entitlement is not the manual access's",
    );
  });

  it("refuses an offer that lists a repository twice", () => {
    expect(() =>
      plan({
        offer: offer({
          accesses: [
            { resourceId: "r1", accessLevel: "write" },
            { resourceId: "r1", accessLevel: "read" },
          ],
        }),
      }),
    ).toThrow("duplicate resource in offer accesses");
  });
});

describe("manualAccessRateLimitBuckets", () => {
  it("counts every owner of a workspace in one daily bucket", () => {
    expect(manualAccessRateLimitBuckets("w1")).toEqual([
      { bucket: "manual_access:w1:d", windowMs: 86_400_000, limit: 50, retired: [] },
    ]);
  });
});
