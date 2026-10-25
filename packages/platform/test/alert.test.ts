import { ALERT_NAMES } from "@sharerepo/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alert, createLogger } from "../src/index.ts";
import { type ConsoleCapture, captureConsole } from "./support/capture-console.ts";

let capture: ConsoleCapture;
beforeEach(() => {
  capture = captureConsole();
});
afterEach(() => {
  capture.restore();
});

describe("alert", () => {
  it.each(ALERT_NAMES)("logs %s as one warn line with its IDs", (name) => {
    const logger = createLogger({ correlationId: "req-00000001" }, { now: () => 0 });
    alert(logger, name, { outboxId: "o-1", attempts: 3 });
    expect(capture.lines.map((line) => line.method)).toEqual(["warn"]);
    expect(capture.records()).toEqual([
      {
        ts: "1970-01-01T00:00:00.000Z",
        level: "warn",
        msg: `alert: ${name}`,
        correlationId: "req-00000001",
        outboxId: "o-1",
        attempts: 3,
        alert: name,
      },
    ]);
  });

  it("cannot be renamed by an ID field", () => {
    const logger = createLogger({ correlationId: "req-00000001" });
    alert(logger, "job_failed", { alert: "sweep_lagging" });
    expect(capture.records()[0]?.alert).toBe("job_failed");
  });
});
