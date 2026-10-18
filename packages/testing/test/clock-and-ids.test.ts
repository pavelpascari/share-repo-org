import type { Clock, IdGenerator } from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import { FakeClock, freshWorkspaceIds, SequentialIds } from "../src/index.ts";

describe("FakeClock", () => {
  it("implements Clock and starts at a fixed UTC instant by default", () => {
    const clock: Clock = new FakeClock();
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1));
  });

  it("accepts an epoch-millisecond, Date, or ISO string start", () => {
    expect(new FakeClock(5).now()).toBe(5);
    expect(new FakeClock(new Date(Date.UTC(2026, 5, 1))).now()).toBe(Date.UTC(2026, 5, 1));
    expect(new FakeClock("2026-03-01T12:00:00Z").now()).toBe(Date.UTC(2026, 2, 1, 12));
  });

  it("stays still until advanced or set", () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.advance(250)).toBe(1_250);
    expect(clock.now()).toBe(1_250);
    clock.set(10);
    expect(clock.now()).toBe(10);
    clock.set(new Date(20));
    expect(clock.now()).toBe(20);
  });

  it("allows advancing by zero", () => {
    const clock = new FakeClock(7);
    expect(clock.advance(0)).toBe(7);
  });

  it("rejects negative or non-finite advances", () => {
    const clock = new FakeClock(0);
    expect(() => clock.advance(-1)).toThrow(/non-negative/);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => clock.advance(Number.NaN)).toThrow(/finite/);
    expect(clock.now()).toBe(0);
  });

  it("rejects invalid instants", () => {
    expect(() => new FakeClock("not a date")).toThrow(/invalid instant/);
    expect(() => new FakeClock(1.5)).toThrow(/invalid instant/);
    expect(() => new FakeClock(0).set(Number.NaN)).toThrow(/invalid instant/);
  });
});

describe("SequentialIds", () => {
  it("implements IdGenerator with a deterministic, zero-padded sequence", () => {
    const ids: IdGenerator = new SequentialIds();
    expect([ids.next(), ids.next(), ids.next()]).toEqual(["id-000001", "id-000002", "id-000003"]);
  });

  it("supports a prefix and start value", () => {
    const ids = new SequentialIds({ prefix: "ws_", start: 41 });
    expect(ids.next()).toBe("ws_000041");
    expect(ids.next()).toBe("ws_000042");
  });

  it("produces the same sequence for the same options", () => {
    const a = new SequentialIds({ prefix: "u-" });
    const b = new SequentialIds({ prefix: "u-" });
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
  });

  it("keeps lexicographic order beyond the padding width", () => {
    const ids = new SequentialIds({ start: 999_999 });
    expect(ids.next()).toBe("id-999999");
    expect(ids.next()).toBe("id-1000000");
  });

  it("rejects an invalid start", () => {
    expect(() => new SequentialIds({ start: -1 })).toThrow(/start/);
    expect(() => new SequentialIds({ start: 1.5 })).toThrow(/start/);
  });
});

describe("freshWorkspaceIds", () => {
  it("returns distinct identifiers on every call", () => {
    const a = freshWorkspaceIds();
    const b = freshWorkspaceIds();
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.userId).not.toBe(b.userId);
    expect(a.slug).not.toBe(b.slug);
    expect(a.workspaceId).not.toBe(a.userId);
  });

  it("uses UUIDs for IDs and a lowercase slug", () => {
    const { workspaceId, userId, slug } = freshWorkspaceIds();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(workspaceId).toMatch(uuid);
    expect(userId).toMatch(uuid);
    expect(slug).toMatch(/^test-[0-9a-f]{12}$/);
  });
});
