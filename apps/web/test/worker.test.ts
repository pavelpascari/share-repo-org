import { exports } from "cloudflare:workers";
import { captureLogs } from "@sharerepo/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Through the deployed entry point (`workers/app.ts`) with the local D1 binding from
// wrangler.jsonc. Failure paths need injected bindings and are in handler.test.ts.

const logs = captureLogs();
afterEach(() => logs.clear());
afterAll(() => logs.restore());

// The first request loads the Worker's module graph, which can exceed the default test timeout.
beforeAll(async () => {
  await get("/healthz");
  logs.clear();
}, 30_000);

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`https://sharerepo.test${path}`, { headers }));
}

describe("web worker entry point", () => {
  it("answers /healthz with 200 and a request ID", async () => {
    const response = await get("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers /readyz with 200 after D1 answers SELECT 1", async () => {
    const response = await get("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { d1: "ok" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("assigns its own request ID and logs a valid incoming one alongside it", async () => {
    const response = await get("/healthz?probe=1", { "x-request-id": "lb-request-0001" });
    const correlationId = response.headers.get("x-request-id");
    expect(correlationId).not.toBe("lb-request-0001");
    const line = JSON.parse(logs.lines().at(-1) ?? "{}");
    expect(line).toMatchObject({
      level: "info",
      msg: "request",
      correlationId,
      clientRequestId: "lb-request-0001",
      method: "GET",
      path: "/healthz",
      status: 200,
    });
  });
});
