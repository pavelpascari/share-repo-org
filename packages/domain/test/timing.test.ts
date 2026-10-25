import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dailyOffsetMs, entitlementValidity, sweepLag } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Decision 0013: an active entitlement past its end waits 6 hours for confirmation.
describe("entitlementValidity", () => {
  it("is desired while open-ended or before its end", () => {
    expect(entitlementValidity(null, NOW)).toBe("desired");
    expect(entitlementValidity(NOW + 1, NOW)).toBe("desired");
  });

  it("timing/expiry-confirmed-before-revoke: is expiry pending from its end for 6 hours", () => {
    expect(entitlementValidity(NOW, NOW)).toBe("expiry_pending");
    expect(entitlementValidity(NOW - 6 * HOUR + 1, NOW)).toBe("expiry_pending");
  });

  it("timing/expiry-revokes-after-confirmation-window: is not desired once the window ends", () => {
    expect(entitlementValidity(NOW - 6 * HOUR, NOW)).toBe("not_desired");
    expect(entitlementValidity(NOW - DAY, NOW)).toBe("not_desired");
  });
});

// Decision 0014: the sweep alerts when its oldest due row is more than 15 minutes late.
describe("sweepLag", () => {
  it("is zero when nothing is due", () => {
    expect(sweepLag([], NOW)).toEqual({ lagMs: 0, lagging: false });
    expect(sweepLag([null, null], NOW)).toEqual({ lagMs: 0, lagging: false });
  });

  it("is the age of the oldest due instant", () => {
    expect(sweepLag([NOW - MINUTE, null, NOW - 3 * MINUTE], NOW)).toEqual({
      lagMs: 3 * MINUTE,
      lagging: false,
    });
    expect(sweepLag([NOW, NOW + MINUTE], NOW)).toEqual({ lagMs: 0, lagging: false });
  });

  it("timing/sweep-lag-alerts: lags once the oldest due row is more than 15 minutes late", () => {
    expect(sweepLag([NOW - 15 * MINUTE], NOW).lagging).toBe(false);
    expect(sweepLag([null, NOW - 15 * MINUTE - 1], NOW)).toEqual({
      lagMs: 15 * MINUTE + 1,
      lagging: true,
    });
  });
});

// Phase-6 plan § Partitioning: daily work is spread over the day by a hash of its subject.
describe("dailyOffsetMs", () => {
  it("is a stable FNV-1a hash of the kind and subject, modulo a day", () => {
    expect(dailyOffsetMs("resync_connection", "conn-1")).toBe(1_134_488_658 % DAY);
    expect(dailyOffsetMs("sweep_paddle_subscriptions", "conn-1")).toBe(1_587_798_129 % DAY);
    expect(dailyOffsetMs("a", "b")).toBe(146_638_144 % DAY);
    expect(dailyOffsetMs("", "")).toBe(1_057_798_253 % DAY);
  });

  it("stays within the day and spreads subjects across it", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (kind, subject) => {
        const offset = dailyOffsetMs(kind, subject);
        expect(Number.isInteger(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(DAY);
      }),
    );
    const hours = new Set(
      Array.from({ length: 200 }, (_, i) =>
        Math.floor(dailyOffsetMs("resync_connection", `conn-${i}`) / HOUR),
      ),
    );
    expect(hours.size).toBeGreaterThan(20);
  });
});
