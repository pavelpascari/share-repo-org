import { env } from "cloudflare:workers";
import type { LogSink } from "@sharerepo/platform";
import { captureLogs, FakeClock, SequentialIds, withSecretCanaries } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/context.ts";
import { createFetchHandler, type RenderApp } from "../workers/handler.ts";

const ctx = {} as ExecutionContext;

interface Harness {
  fetch: (request: Request, env?: unknown) => Promise<Response>;
  logs: () => Array<Record<string, unknown>>;
  clock: FakeClock;
}

function harness(renderApp: RenderApp = async () => new Response("<html>home</html>")): Harness {
  const lines: string[] = [];
  const record = (line: string) => lines.push(line);
  const logSink: LogSink = { debug: record, info: record, warn: record, error: record };
  const clock = new FakeClock("2026-10-18T12:00:00Z");
  const handler = createFetchHandler({
    renderApp,
    ids: new SequentialIds({ prefix: "req-" }),
    now: () => clock.now(),
    logSink,
  });
  return {
    fetch: (request, workerEnv = env) => handler(request, workerEnv, ctx),
    logs: () => lines.map((line) => JSON.parse(line)),
    clock,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://sharerepo.test${path}`, init);
}

/** A D1 binding whose every statement fails the way the driver does, with SQL in the message. */
function brokenD1(message: string): D1Database {
  const fail = () => Promise.reject(new Error(message));
  const statement = { bind: () => statement, run: fail, all: fail, raw: fail, first: fail };
  return { prepare: () => statement } as unknown as D1Database;
}

/** A D1 binding that records every method call instead of running it. */
function recordingD1(calls: string[]): D1Database {
  return new Proxy({} as D1Database, {
    get: (_target, property) => () => {
      calls.push(String(property));
      throw new Error("D1 must not be called");
    },
  });
}

describe("createFetchHandler", () => {
  describe("/healthz", () => {
    it("returns 200 without touching D1", async () => {
      const calls: string[] = [];
      const { fetch } = harness(() => Promise.reject(new Error("must not render")));
      const response = await fetch(request("/healthz"), { ...env, DB: recordingD1(calls) });
      expect(response.status).toBe(200);
      expect(calls).toEqual([]);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ status: "ok" });
    });

    it("answers HEAD and rejects other methods with 405", async () => {
      const { fetch } = harness();
      expect((await fetch(request("/healthz", { method: "HEAD" }))).status).toBe(200);
      const post = await fetch(request("/healthz", { method: "POST" }));
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
      expect(post.headers.get("x-request-id")).toBe("req-000002");
      expect(await post.json()).toEqual({
        error: { code: "method_not_allowed", message: "The request method is not allowed." },
        requestId: "req-000002",
      });
    });
  });

  describe("/readyz", () => {
    it("returns 200 when D1 answers through the db package", async () => {
      const { fetch } = harness();
      const response = await fetch(request("/readyz"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ready", checks: { d1: "ok" } });
    });

    it("returns a classified 503 and logs no driver detail when D1 fails", async () => {
      const driverMessage = "D1_ERROR: no such table: secrets; SQL: select 'hunter2'";
      const { fetch, logs } = harness();
      const response = await fetch(request("/readyz"), { ...env, DB: brokenD1(driverMessage) });

      expect(response.status).toBe(503);
      expect(response.headers.get("x-request-id")).toBe("req-000001");
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: {
          code: "service_unavailable",
          message: "The service is temporarily unavailable.",
        },
        requestId: "req-000001",
      });

      const [warning, access] = logs();
      expect(warning).toMatchObject({
        level: "warn",
        msg: "readiness check failed",
        correlationId: "req-000001",
        check: "d1",
        errorName: "Error",
      });
      expect(access).toMatchObject({ msg: "request", status: 503 });
      const everything = body + JSON.stringify(logs());
      expect(everything).not.toContain("hunter2");
      expect(everything).not.toContain("no such table");
    });
  });

  describe("request IDs", () => {
    it("accepts a valid incoming x-request-id", async () => {
      const { fetch } = harness();
      const response = await fetch(request("/", { headers: { "x-request-id": "edge-abc-123" } }));
      expect(response.headers.get("x-request-id")).toBe("edge-abc-123");
    });

    it("replaces an invalid incoming x-request-id with a generated one", async () => {
      const { fetch } = harness();
      const response = await fetch(request("/", { headers: { "x-request-id": "bad id\n" } }));
      expect(response.headers.get("x-request-id")).toBe("req-000001");
    });

    it("adds the header to React Router responses with immutable headers", async () => {
      const { fetch } = harness(async () => Response.redirect("https://sharerepo.test/x", 302));
      const response = await fetch(request("/"));
      expect(response.status).toBe(302);
      expect(response.headers.get("x-request-id")).toBe("req-000001");
    });
  });

  describe("React Router rendering", () => {
    it("passes the request and the env through the router context", async () => {
      let seen: { url: string; environment: string } | undefined;
      const { fetch } = harness(async (req, context) => {
        seen = { url: req.url, environment: context.get(cloudflareContext).env.ENVIRONMENT };
        return new Response("rendered", { status: 200 });
      });
      const response = await fetch(request("/pricing"));
      expect(await response.text()).toBe("rendered");
      expect(seen).toEqual({ url: "https://sharerepo.test/pricing", environment: "development" });
    });

    it("turns an unhandled render error into a generic 500 with no secret or stack", async () => {
      await withSecretCanaries(["apiToken"], async (canaries, consoleLogs) => {
        const { fetch, logs } = harness(() => {
          throw new TypeError(`render failed with token ${canaries.apiToken}`);
        });
        const response = await fetch(request("/"));

        expect(response.status).toBe(500);
        expect(response.headers.get("x-request-id")).toBe("req-000001");
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({
          error: { code: "internal_error", message: "Internal error" },
          requestId: "req-000001",
        });
        expect(body).not.toMatch(/TypeError|stack|at /);

        const [failure, access] = logs();
        expect(failure).toEqual({
          ts: "2026-10-18T12:00:00.000Z",
          level: "error",
          msg: "unhandled error",
          correlationId: "req-000001",
          errorName: "TypeError",
        });
        expect(access).toMatchObject({ msg: "request", status: 500 });
        expect(consoleLogs.entries).toEqual([]);
        return { body, logs: logs() };
      });
    });

    it("classifies a deliberate AppError by its code and status", async () => {
      const { NotFoundError } = await import("@sharerepo/platform");
      const { fetch, logs } = harness(() => Promise.reject(new NotFoundError()));
      const response = await fetch(request("/missing"));
      expect(response.status).toBe(404);
      expect(logs()[0]).toMatchObject({
        level: "error",
        errorName: "NotFoundError",
        errorCode: "not_found",
      });
    });

    it("classifies a thrown non-Error value without logging it", async () => {
      const { fetch, logs } = harness(() => Promise.reject("raw string with secret"));
      const response = await fetch(request("/"));
      expect(response.status).toBe(500);
      expect(logs()[0]).toMatchObject({ errorName: "unknown" });
      expect(JSON.stringify(logs())).not.toContain("raw string");
    });
  });

  describe("environment", () => {
    it("returns a generic 500 and logs only key paths when bindings are invalid", async () => {
      await withSecretCanaries(["environment"], async (canaries) => {
        const { fetch, logs } = harness();
        const response = await fetch(request("/healthz"), {
          DB: "not-a-binding",
          ENVIRONMENT: canaries.environment,
        });

        expect(response.status).toBe(500);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({
          error: { code: "internal_error", message: "Internal error" },
          requestId: "req-000001",
        });
        expect(logs()[0]).toMatchObject({
          level: "error",
          msg: "invalid environment configuration",
          correlationId: "req-000001",
          errorCode: "configuration_error",
          issues: [
            { path: "DB", code: "invalid_type" },
            { path: "ENVIRONMENT", code: "invalid_value" },
          ],
        });
        return { body, logs: logs() };
      });
    });

    it("rejects a missing env object", async () => {
      const { fetch, logs } = harness();
      const response = await fetch(request("/healthz"), null);
      expect(response.status).toBe(500);
      expect(logs()[0]).toMatchObject({ issues: [{ path: "(root)", code: "invalid_type" }] });
    });
  });

  describe("request logging", () => {
    it("logs one line per request with method, path, status and duration only", async () => {
      const { fetch, logs, clock } = harness(async () => {
        clock.advance(42);
        return new Response("ok", { status: 201 });
      });
      await fetch(
        request("/account?token=SECRET_QUERY&code=abc", {
          method: "POST",
          headers: { cookie: "session=SECRET_COOKIE", authorization: "Bearer SECRET_HEADER" },
        }),
      );

      expect(logs()).toEqual([
        {
          ts: "2026-10-18T12:00:00.042Z",
          level: "info",
          msg: "request",
          correlationId: "req-000001",
          method: "POST",
          path: "/account",
          status: 201,
          durationMs: 42,
        },
      ]);
      expect(JSON.stringify(logs())).not.toMatch(/SECRET_|code=abc/);
    });

    it("defaults to random IDs, the system clock and the console", async () => {
      using consoleLogs = captureLogs();
      const handler = createFetchHandler({ renderApp: async () => new Response("ok") });
      const response = await handler(request("/"), env, ctx);
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(consoleLogs.entries.map((entry) => entry.level)).toEqual(["info"]);
    });
  });
});
