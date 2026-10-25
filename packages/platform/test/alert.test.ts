import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alert, createLogger } from "../src/index.ts";
import { type ConsoleCapture, captureConsole } from "./support/capture-console.ts";

const now = () => Date.UTC(2026, 9, 25, 12, 0, 0);

let capture: ConsoleCapture;
beforeEach(() => {
  capture = captureConsole();
});
afterEach(() => {
  capture.restore();
});

describe("alert", () => {
  it("logs one warn line with the alert name and its IDs", () => {
    const logger = createLogger({ correlationId: "req-00000001", worker: "jobs" }, { now });
    alert(logger, "sweep_lagging", { lagMs: 960_000, reconcileDueAt: null });
    expect(capture.lines.map((line) => line.method)).toEqual(["warn"]);
    expect(capture.records()).toEqual([
      {
        ts: "2026-10-25T12:00:00.000Z",
        level: "warn",
        msg: "alert",
        correlationId: "req-00000001",
        worker: "jobs",
        lagMs: 960_000,
        reconcileDueAt: null,
        alert: "sweep_lagging",
      },
    ]);
  });

  it("cannot be renamed by its IDs", () => {
    const logger = createLogger({ correlationId: "req-00000001" }, { now });
    alert(logger, "job_failed", { alert: "something_else" });
    alert(logger, "connection_lost");
    expect(capture.records().map((record) => record.alert)).toEqual([
      "job_failed",
      "connection_lost",
    ]);
  });
});
