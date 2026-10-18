import type { SimulatedSubscription } from "@sharerepo/db";
import { createSecretCanaries, expectNoCanaryLeak } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { simulatedSnapshot } from "../src/entitlement-source.ts";
import {
  decodeOfferKey,
  decodeRefreshKey,
  encodeOfferKey,
  encodeRefreshKey,
  simulatedEntitlementSource,
} from "../src/index.ts";
import { DAY, shop, subscribe } from "./support/commerce.ts";
import { db } from "./support/context.ts";

const T = Date.UTC(2026, 2, 1);

const row = (overrides: Partial<SimulatedSubscription> = {}): SimulatedSubscription => ({
  id: "sim-1",
  workspaceId: "ws-1",
  customerGithubId: "583231",
  customerLogin: "octocat",
  items: JSON.stringify(["sim_pro"]),
  state: "past_due",
  currentPeriodStart: T,
  currentPeriodEnd: T + 30 * DAY,
  cancelAt: null,
  endedAt: null,
  pastDueSince: T + DAY,
  createdAt: T,
  updatedAt: T + DAY,
  ...overrides,
});

describe("simulatedSnapshot", () => {
  it("maps the source row to a normalized snapshot and an explicit GitHub link", () => {
    expect(simulatedSnapshot(row())).toEqual({
      found: true,
      snapshot: {
        externalSubscriptionId: "sim-1",
        externalCustomerId: "github:583231",
        items: ["sim_pro"],
        state: "past_due",
        providerState: "past_due",
        currentPeriodStart: T,
        currentPeriodEnd: T + 30 * DAY,
        cancelAt: null,
        endedAt: null,
        pastDueSince: T + DAY,
        sourceUpdatedAt: T + DAY,
      },
      customerLink: { provider: "github", externalSubjectId: "583231", login: "octocat" },
    });
  });

  it.each([
    ["breaks the state invariants", (c: string) => row({ customerLogin: c, pastDueSince: null })],
    ["has items that are not JSON", (c: string) => row({ items: `[${c}` })],
    ["has duplicate items", (c: string) => row({ items: JSON.stringify([c, c]) })],
  ])("is an internal error, echoing no values, when the row %s", (_, make) => {
    const canaries = createSecretCanaries(["value"]);
    let thrown: unknown;
    try {
      simulatedSnapshot(make(canaries.value));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expectNoCanaryLeak(thrown, canaries);
  });
});

describe("simulatedEntitlementSource", () => {
  it("reads the workspace's own simulated subscriptions only", async () => {
    const s = await shop();
    const other = await shop();
    const sub = await subscribe(s, { items: ["sim_pro"] });
    const port = simulatedEntitlementSource(db);
    expect(port.source).toBe("simulated");
    await expect(
      port.refreshSubscription({ workspaceId: s.workspaceId, externalSubscriptionId: sub.id }),
    ).resolves.toMatchObject({ found: true, snapshot: { externalSubscriptionId: sub.id } });
    await expect(
      port.refreshSubscription({ workspaceId: other.workspaceId, externalSubscriptionId: sub.id }),
    ).resolves.toEqual({ found: false });
  });
});

describe("outbox subject keys", () => {
  it("round-trips a refresh key, even when the external ID contains separators", () => {
    const ref = {
      workspaceId: "ws-1",
      source: "paddle",
      externalSubscriptionId: "sub:01h:x",
    } as const;
    expect(encodeRefreshKey(ref)).toBe("ws-1:paddle:sub:01h:x");
    expect(decodeRefreshKey(encodeRefreshKey(ref))).toEqual({ ok: true, value: ref });
  });

  it.each(["", "ws-1", "ws-1:simulated", "ws-1:simulated:", "ws-1:stripe:sub", ":simulated:x"])(
    "refuses the refresh key %j",
    (key) => {
      expect(decodeRefreshKey(key)).toEqual({ ok: false, error: "key_invalid" });
    },
  );

  it("round-trips an offer key and refuses malformed ones", () => {
    const ref = { workspaceId: "ws-1", offerId: "offer-1" };
    expect(encodeOfferKey(ref)).toBe("ws-1:offer-1");
    expect(decodeOfferKey("ws-1:offer-1")).toEqual({ ok: true, value: ref });
    for (const key of ["", "ws-1", "ws-1:", ":offer-1", "ws-1:offer-1:extra"]) {
      expect(decodeOfferKey(key)).toEqual({ ok: false, error: "key_invalid" });
    }
  });

  it("refuses to encode IDs that would make a key ambiguous", () => {
    expect(() =>
      encodeRefreshKey({ workspaceId: "a:b", source: "simulated", externalSubscriptionId: "x" }),
    ).toThrow();
    expect(() => encodeOfferKey({ workspaceId: "ws-1", offerId: "a:b" })).toThrow();
  });
});
