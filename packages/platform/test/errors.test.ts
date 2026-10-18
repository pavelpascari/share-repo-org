import { describe, expect, it } from "vitest";
import {
  AppError,
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  toErrorResponse,
  UnauthorizedError,
  ValidationError,
} from "../src/index.ts";

const requestId = "req-12345678";

async function body(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe("AppError hierarchy", () => {
  it.each([
    [ValidationError, 400, "validation_failed", "The request is invalid."],
    [UnauthorizedError, 401, "unauthorized", "Authentication is required."],
    [ForbiddenError, 403, "forbidden", "You do not have access to this resource."],
    [NotFoundError, 404, "not_found", "The requested resource was not found."],
    [ConflictError, 409, "conflict", "The request conflicts with the current state."],
    [
      ServiceUnavailableError,
      503,
      "service_unavailable",
      "The service is temporarily unavailable.",
    ],
  ] as const)("%o maps to %i with a safe default public message", (Ctor, status, code, expose) => {
    const error = new Ctor("internal detail: row 42 in workspace ws_1");
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.httpStatus).toBe(status);
    expect(error.code).toBe(code);
    expect(error.expose).toBe(expose);
    expect(error.message).toBe("internal detail: row 42 in workspace ws_1");
    expect(error.name).toBe(Ctor.name);
  });

  it("accepts an explicit public message, code and cause", () => {
    const cause = new Error("db said no");
    const error = new ConflictError("unique constraint failed on slug", {
      expose: "That slug is already taken.",
      code: "slug_taken",
      cause,
    });
    expect(error.expose).toBe("That slug is already taken.");
    expect(error.code).toBe("slug_taken");
    expect(error.cause).toBe(cause);
  });

  it("uses the class default message when none is given", () => {
    expect(new NotFoundError().message).toBe("The requested resource was not found.");
  });

  it("ConfigurationError is a non-exposed 500", () => {
    const error = new ConfigurationError("Invalid environment: DB (invalid_type)");
    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(500);
    expect(error.code).toBe("configuration_error");
    expect(error.expose).toBeUndefined();
    expect(error.issues).toEqual([]);
  });

  it("supports custom subclasses built directly on AppError", () => {
    const error = new AppError("rate limited by provider", {
      code: "rate_limited",
      httpStatus: 429,
      expose: "Too many requests.",
    });
    expect(error.name).toBe("AppError");
    expect(error.httpStatus).toBe(429);
  });
});

describe("toErrorResponse", () => {
  it("returns the public message, code, status and request id for an AppError", async () => {
    const response = toErrorResponse(
      new ForbiddenError("user u_1 is not a member of ws_9"),
      requestId,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(requestId);
    expect(await body(response)).toEqual({
      error: { code: "forbidden", message: "You do not have access to this resource." },
      requestId,
    });
  });

  it("never exposes the internal message of an AppError", async () => {
    const text = await toErrorResponse(
      new NotFoundError("SELECT * FROM secrets"),
      requestId,
    ).text();
    expect(text).not.toContain("SELECT");
  });

  it("hides non-exposed AppErrors behind a generic 500", async () => {
    const response = toErrorResponse(
      new ConfigurationError("Invalid environment: GITHUB_APP_PRIVATE_KEY (too_small)"),
      requestId,
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "Internal error" },
      requestId,
    });
    expect(text).not.toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it.each([
    ["Error", new Error("connection string postgres://user:pw@host")],
    ["TypeError", new TypeError("cannot read properties of undefined (reading 'token')")],
    ["string", "boom: secret"],
    ["object", { message: "leak", stack: "at secret.ts:1" }],
    ["null", null],
    ["undefined", undefined],
  ])("maps an unknown %s to a generic 500 without internals", async (_label, thrown) => {
    const response = toErrorResponse(thrown, requestId);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "Internal error" },
      requestId,
    });
    expect(text).not.toMatch(/postgres|token|secret|leak|stack|at /);
  });
});
