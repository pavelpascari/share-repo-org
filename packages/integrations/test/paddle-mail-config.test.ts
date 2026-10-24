import { ConfigurationError } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import { PADDLE_API_BASE_URLS, parseMailConfig, parsePaddleConfig } from "../src/index.ts";

function issuesOf(parse: (env: unknown) => unknown, env: unknown) {
  try {
    parse(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).issues;
  }
  throw new Error("expected the parser to throw");
}

const FAKE = "http://localhost:5191/api";
const CAPTURE = "http://localhost:5191/mail";
const binding = { send: async () => undefined };

describe("parsePaddleConfig", () => {
  it.each(["development", "production"])("uses Paddle's own APIs in %s", (environment) => {
    expect(parsePaddleConfig({ ENVIRONMENT: environment })).toEqual({
      apiBaseUrls: { sandbox: "https://sandbox-api.paddle.com", live: "https://api.paddle.com" },
    });
    expect(PADDLE_API_BASE_URLS.live).toBe("https://api.paddle.com");
  });

  it("points both environments at the fake in e2e", () => {
    expect(
      parsePaddleConfig({ ENVIRONMENT: "e2e", PADDLE_API_BASE_URL: `${FAKE}/` }).apiBaseUrls,
    ).toEqual({ sandbox: FAKE, live: FAKE });
    expect(parsePaddleConfig({ ENVIRONMENT: "e2e" }).apiBaseUrls).toBe(PADDLE_API_BASE_URLS);
  });

  it.each(["development", "production"])("refuses the override in %s", (environment) => {
    expect(
      issuesOf(parsePaddleConfig, { ENVIRONMENT: environment, PADDLE_API_BASE_URL: FAKE }),
    ).toEqual([{ path: "PADDLE_API_BASE_URL", code: "custom" }]);
  });

  it("refuses an override that is not an http URL", () => {
    expect(
      issuesOf(parsePaddleConfig, { ENVIRONMENT: "e2e", PADDLE_API_BASE_URL: "ftp://fake" }),
    ).toEqual([{ path: "PADDLE_API_BASE_URL", code: "invalid_format" }]);
  });
});

describe("parseMailConfig", () => {
  it("has no transport by default", () => {
    expect(parseMailConfig({ ENVIRONMENT: "production" })).toBeNull();
  });

  it("uses the send_email binding when one is bound", () => {
    expect(parseMailConfig({ ENVIRONMENT: "production", EMAIL: binding })).toEqual({
      kind: "binding",
      binding,
    });
  });

  it("captures mail over HTTP in e2e, ahead of a binding", () => {
    expect(
      parseMailConfig({ ENVIRONMENT: "e2e", MAIL_CAPTURE_URL: CAPTURE, EMAIL: binding }),
    ).toEqual({ kind: "capture", url: CAPTURE });
  });

  it.each(["development", "production"])("refuses the capture URL in %s", (environment) => {
    expect(
      issuesOf(parseMailConfig, { ENVIRONMENT: environment, MAIL_CAPTURE_URL: CAPTURE }),
    ).toEqual([{ path: "MAIL_CAPTURE_URL", code: "custom" }]);
  });

  it.each([
    ["a string", "EMAIL"],
    ["null", null],
    ["an object without send", { name: "EMAIL" }],
  ])("refuses an EMAIL binding that is %s", (_label, value) => {
    expect(issuesOf(parseMailConfig, { ENVIRONMENT: "production", EMAIL: value })).toEqual([
      { path: "EMAIL", code: "custom" },
    ]);
  });
});
