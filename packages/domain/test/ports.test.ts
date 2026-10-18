import { describe, expect, it } from "vitest";
import { randomIds, systemClock } from "../src/index.ts";

describe("default ports", () => {
  it("systemClock returns the current UTC epoch milliseconds", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("randomIds returns distinct UUIDs", () => {
    const a = randomIds.next();
    const b = randomIds.next();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
