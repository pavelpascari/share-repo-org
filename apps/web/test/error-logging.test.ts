import { createLogger, NotFoundError } from "@sharerepo/platform";
import { createSecretCanaries, expectNoCanaryLeak } from "@sharerepo/testing";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { logRouteError, requestLogger } from "../app/error-logging.ts";
import { requestContext } from "./support/request-context.ts";

function recordingLogger() {
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const logger = createLogger(
    { correlationId: "corr-test" },
    { sink: { debug: record, info: record, warn: record, error: record } },
  );
  return { logger, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe("logRouteError", () => {
  it("logs only the class of a database error, never its SQL or parameters", () => {
    const canaries = createSecretCanaries(["userId"]);
    const { logger, parsed } = recordingLogger();
    const error = new Error(
      `Failed query: select * from users where id = ? params: ${canaries.userId}`,
    );
    logRouteError(logger, error);
    expect(parsed()).toMatchObject([{ level: "error", msg: "route error", errorName: "Error" }]);
    expectNoCanaryLeak(parsed(), canaries);
  });

  it("includes the code of an application error", () => {
    const { logger, parsed } = recordingLogger();
    logRouteError(logger, new NotFoundError());
    expect(parsed()[0]).toMatchObject({ errorName: "NotFoundError", errorCode: "not_found" });
  });

  it("handles thrown values that are not errors", () => {
    const { logger, parsed } = recordingLogger();
    logRouteError(logger, "a string");
    expect(parsed()[0]).toMatchObject({ errorName: "unknown" });
  });
});

describe("requestLogger", () => {
  it("returns the request's logger when the Worker entry set one", () => {
    expect(requestLogger(requestContext())).toBeDefined();
  });

  it("returns undefined for a context without one", () => {
    expect(requestLogger(new RouterContextProvider())).toBeUndefined();
  });
});
