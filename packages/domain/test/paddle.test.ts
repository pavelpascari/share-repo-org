import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_CALL_OUTCOMES,
  type ConnectionCallOutcome,
  nextConnectionStatus,
  ConnectionCallOutcome as Outcome,
  PADDLE_CONNECTION_STATUSES,
  type PaddleConnectionStatus,
} from "../src/index.ts";

describe("connection call outcomes", () => {
  it("lists them", () =>
    expect(CONNECTION_CALL_OUTCOMES).toEqual(["ok", "unauthorized", "transient", "rejected"]));
  it("by name", () => expect(Object.values(Outcome)).toEqual(CONNECTION_CALL_OUTCOMES));
});

describe("nextConnectionStatus (decision 0011 § Health)", () => {
  it.each([
    ["active", "ok", "active"],
    ["active", "unauthorized", "unauthorized"],
    ["active", "transient", "active"],
    ["active", "rejected", "active"],
    ["unauthorized", "ok", "active"],
    ["unauthorized", "unauthorized", "unauthorized"],
    ["unauthorized", "transient", "unauthorized"],
    ["unauthorized", "rejected", "unauthorized"],
    ["disconnected", "ok", "disconnected"],
    ["disconnected", "unauthorized", "disconnected"],
    ["disconnected", "transient", "disconnected"],
    ["disconnected", "rejected", "disconnected"],
  ] as const)("%s after %s is %s", (current, outcome, expected) => {
    expect(nextConnectionStatus(current, outcome)).toBe(expected);
  });

  const status = fc.constantFrom<PaddleConnectionStatus>(...PADDLE_CONNECTION_STATUSES);
  const outcomes = fc.array(fc.constantFrom<ConnectionCallOutcome>(...CONNECTION_CALL_OUTCOMES));

  it("never leaves or enters disconnected, and transient errors change nothing", () => {
    fc.assert(
      fc.property(status, outcomes, (start, seq) => {
        let current = start;
        for (const outcome of seq) {
          const next = nextConnectionStatus(current, outcome);
          expect(next === "disconnected").toBe(current === "disconnected");
          if (outcome === "transient") expect(next).toBe(current);
          current = next;
        }
      }),
    );
  });
});
