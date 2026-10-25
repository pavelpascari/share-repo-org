import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  carryPastDueSince,
  isNewerSnapshot,
  parseSubscriptionSnapshot,
  type SubscriptionSnapshot,
} from "../src/index.ts";

const T = 1_700_000_000_000;

const snapshot = (overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  externalSubscriptionId: "sub_1",
  externalCustomerId: "ctm_1",
  items: ["sim_monthly"],
  state: "active",
  providerState: "active",
  currentPeriodStart: T,
  currentPeriodEnd: T + 1,
  cancelAt: null,
  endedAt: null,
  pastDueSince: null,
  sourceUpdatedAt: T,
  ...overrides,
});

const accepts = (s: unknown) =>
  expect(parseSubscriptionSnapshot(s)).toEqual({ ok: true, value: s });
const rejects = (s: unknown) =>
  expect(parseSubscriptionSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });

describe("parseSubscriptionSnapshot", () => {
  it("accepts a valid snapshot", () => accepts(snapshot()));

  it("accepts open periods, no items, a scheduled cancellation and the epoch", () => {
    accepts(snapshot({ currentPeriodStart: null, currentPeriodEnd: null }));
    accepts(snapshot({ currentPeriodStart: null }));
    accepts(snapshot({ currentPeriodEnd: null }));
    accepts(snapshot({ items: [] }));
    accepts(snapshot({ cancelAt: T + 5, currentPeriodStart: 0, sourceUpdatedAt: 0 }));
    // An open bound is not compared, even with an end at the epoch.
    accepts(snapshot({ currentPeriodStart: null, currentPeriodEnd: 0 }));
    accepts(snapshot({ currentPeriodStart: T, currentPeriodEnd: null }));
  });

  it("drops unknown keys", () => {
    expect(parseSubscriptionSnapshot({ ...snapshot(), raw: "payload" })).toEqual({
      ok: true,
      value: snapshot(),
    });
  });

  it("requires pastDueSince exactly when past due", () => {
    accepts(snapshot({ state: "past_due", pastDueSince: T }));
    rejects(snapshot({ state: "past_due" }));
    rejects(snapshot({ state: "active", pastDueSince: T }));
  });

  it.each(["canceled", "expired"] as const)("requires endedAt exactly when %s", (state) => {
    accepts(snapshot({ state, endedAt: T }));
    rejects(snapshot({ state }));
  });

  it.each(["trialing", "active", "paused"] as const)("refuses endedAt when %s", (state) => {
    accepts(snapshot({ state }));
    rejects(snapshot({ state, endedAt: T }));
  });

  it("requires the period to end after it starts", () => {
    rejects(snapshot({ currentPeriodStart: T, currentPeriodEnd: T }));
    rejects(snapshot({ currentPeriodStart: T, currentPeriodEnd: T - 1 }));
  });

  it("requires unique, non-empty items", () => {
    rejects(snapshot({ items: ["a", "a"] }));
    rejects(snapshot({ items: [""] }));
  });

  it.each([
    ["externalSubscriptionId", ""],
    ["externalCustomerId", ""],
    ["providerState", ""],
    ["state", "unpaid"],
    ["sourceUpdatedAt", -1],
    ["sourceUpdatedAt", 1.5],
    ["sourceUpdatedAt", null],
    ["cancelAt", -1],
    ["currentPeriodStart", "1"],
    ["items", "a"],
  ])("rejects %s %j", (key, value) => rejects({ ...snapshot(), [key]: value }));

  it("rejects a non-object", () => rejects("x"));
});

describe("isNewerSnapshot", () => {
  it("applies the first snapshot", () => {
    expect(isNewerSnapshot(null, { sourceUpdatedAt: 0 })).toBe(true);
  });

  it("applies only a strictly newer snapshot", () => {
    expect(isNewerSnapshot({ sourceUpdatedAt: T }, { sourceUpdatedAt: T + 1 })).toBe(true);
    expect(isNewerSnapshot({ sourceUpdatedAt: T }, { sourceUpdatedAt: T })).toBe(false);
    expect(isNewerSnapshot({ sourceUpdatedAt: T }, { sourceUpdatedAt: T - 1 })).toBe(false);
  });

  it("webhook/out-of-order-does-not-regress: any delivery order with duplicates ends at the newest snapshot", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 })
          .chain((times) =>
            fc.tuple(
              fc.constant(times),
              // Every snapshot is delivered at least once, some more than once, in any order.
              fc.shuffledSubarray([...times, ...times, ...times], {
                minLength: times.length * 3,
              }),
              fc.array(fc.constantFrom(...times)),
            ),
          ),
        ([times, deliveries, extra]) => {
          let stored: { sourceUpdatedAt: number } | null = null;
          for (const sourceUpdatedAt of [...deliveries, ...extra]) {
            const incoming = { sourceUpdatedAt };
            if (isNewerSnapshot(stored, incoming)) stored = incoming;
          }
          expect(stored?.sourceUpdatedAt).toBe(Math.max(...times));
        },
      ),
    );
  });
});

describe("carryPastDueSince", () => {
  const pastDue = (since: number) => ({ pastDueSince: since });
  const notPastDue = { pastDueSince: null };

  it.each([
    ["nothing is stored", null, pastDue(T), T],
    ["the stored subscription was not past due", notPastDue, pastDue(T), T],
    ["it stays past due, restamped later", pastDue(T), pastDue(T + 5), T],
    ["it stays past due, reported earlier", pastDue(T + 5), pastDue(T), T],
    ["it recovers", pastDue(T), notPastDue, null],
    ["it was and is not past due", notPastDue, notPastDue, null],
    ["nothing is stored and it is not past due", null, notPastDue, null],
  ] as const)("when %s", (_, stored, incoming, expected) => {
    expect(carryPastDueSince(stored, incoming)).toBe(expected);
  });

  // The domain half of timing/past-due-within-grace-keeps-access; the service test proves the rest.
  it("updates while past due never move the start of grace later", () => {
    const since = fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null });
    fc.assert(
      fc.property(fc.array(since, { minLength: 1 }), (sequence) => {
        let stored: { pastDueSince: number | null } | null = null;
        let runStart: number | null = null;
        for (const incoming of sequence) {
          const next = carryPastDueSince(stored, { pastDueSince: incoming });
          // Past due exactly when the incoming snapshot is.
          expect(next === null).toBe(incoming === null);
          // Within a past-due run, the start is the earliest reported.
          runStart = incoming === null ? null : Math.min(runStart ?? incoming, incoming);
          expect(next).toBe(runStart);
          stored = { pastDueSince: next };
        }
      }),
    );
  });
});
