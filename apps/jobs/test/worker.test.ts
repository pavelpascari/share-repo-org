import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { REQUEST_ID_HEADER } from "@sharerepo/platform";
import {
  captureLogs,
  FakeClock,
  type LogCapture,
  SequentialIds,
  withSecretCanaries,
} from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobsWorker } from "../src/handlers.ts";
import worker from "../src/index.ts";

const SCHEDULED_TIME = Date.UTC(2026, 9, 18, 12, 0, 0);

function testWorker(clock = new FakeClock("2026-10-18T12:00:01.500Z")) {
  return createJobsWorker({ ids: new SequentialIds({ prefix: "corr-" }), clock });
}

function runScheduled(target: ExportedHandler<Env>, bindings: object = env) {
  return target.scheduled?.(
    createScheduledController({ cron: "0 * * * *", scheduledTime: SCHEDULED_TIME }),
    bindings as Env,
    createExecutionContext(),
  );
}

function fetchFrom(target: ExportedHandler<Env>, request: Request): Promise<Response> {
  const response = target.fetch?.(
    request as Request<unknown, IncomingRequestCfProperties>,
    env,
    createExecutionContext(),
  );
  if (response === undefined) throw new Error("worker has no fetch handler");
  return Promise.resolve(response);
}

function parsedLines(logs: LogCapture): Record<string, unknown>[] {
  return logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("scheduled()", () => {
  let logs: LogCapture;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => {
    logs.restore();
  });

  it("logs exactly one structured heartbeat with a generated correlation ID", async () => {
    await expect(runScheduled(testWorker())).resolves.toBeUndefined();

    expect(logs.entries.map((entry) => entry.level)).toEqual(["info"]);
    expect(parsedLines(logs)).toEqual([
      {
        ts: "2026-10-18T12:00:01.500Z",
        level: "info",
        msg: "scheduled heartbeat",
        correlationId: "corr-000001",
        worker: "jobs",
        environment: "development",
        cron: "0 * * * *",
        scheduledTime: "2026-10-18T12:00:00.000Z",
      },
    ]);
  });

  it("uses a fresh correlation ID for every invocation", async () => {
    const target = testWorker();
    await runScheduled(target);
    await runScheduled(target);
    expect(parsedLines(logs).map((line) => line.correlationId)).toEqual([
      "corr-000001",
      "corr-000002",
    ]);
  });

  it("does not fail when logging fails", async () => {
    console.info = () => {
      throw new Error("sink unavailable");
    };
    await expect(runScheduled(testWorker())).resolves.toBeUndefined();
  });

  it("logs a classified error and rethrows when the environment is invalid", async () => {
    await expect(runScheduled(testWorker(), { ENVIRONMENT: "staging" })).rejects.toMatchObject({
      name: "ConfigurationError",
      code: "configuration_error",
    });

    expect(logs.entries.map((entry) => entry.level)).toEqual(["error"]);
    expect(parsedLines(logs)).toEqual([
      {
        ts: "2026-10-18T12:00:01.500Z",
        level: "error",
        msg: "invalid environment configuration",
        correlationId: "corr-000001",
        worker: "jobs",
        cron: "0 * * * *",
        error: {
          name: "ConfigurationError",
          message:
            "Invalid environment configuration: DB (invalid_type), ENVIRONMENT (invalid_value)",
          code: "configuration_error",
        },
      },
    ]);
  });

  it("runs through the default export", async () => {
    await expect(runScheduled(worker)).resolves.toBeUndefined();
    const [line] = parsedLines(logs);
    expect(line).toMatchObject({ level: "info", msg: "scheduled heartbeat", worker: "jobs" });
    expect(line?.correlationId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  });
});

describe("scheduled() secret hygiene", () => {
  it("keeps unrelated secret bindings out of the heartbeat", async () => {
    await withSecretCanaries(["githubToken", "paddleApiKey"], async (canaries, logs) => {
      await runScheduled(testWorker(), {
        ...env,
        GITHUB_TOKEN: canaries.githubToken,
        PADDLE_API_KEY: canaries.paddleApiKey,
      });
      expect(logs.entries).toHaveLength(1);
    });
  });

  it("never logs or throws the rejected values of an invalid environment", async () => {
    await withSecretCanaries(["environment", "db"], async (canaries, logs) => {
      await expect(
        runScheduled(testWorker(), { DB: canaries.db, ENVIRONMENT: canaries.environment }),
      ).rejects.toThrow("Invalid environment configuration");
      expect(logs.entries).toHaveLength(1);
    });
  });
});

describe("fetch()", () => {
  it("answers GET /healthz with a generated request ID", async () => {
    const response = await fetchFrom(testWorker(), new Request("http://jobs/healthz"));
    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("corr-000001");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("echoes a valid incoming x-request-id", async () => {
    const response = await fetchFrom(
      testWorker(),
      new Request("http://jobs/healthz", { headers: { [REQUEST_ID_HEADER]: "probe-1234abcd" } }),
    );
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("probe-1234abcd");
  });

  it("replaces an invalid incoming x-request-id", async () => {
    const response = await fetchFrom(
      testWorker(),
      new Request("http://jobs/healthz", { headers: { [REQUEST_ID_HEADER]: "bad id<script>" } }),
    );
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("corr-000001");
  });

  it("returns a JSON 404 for unknown paths", async () => {
    const response = await fetchFrom(testWorker(), new Request("http://jobs/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("corr-000001");
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "The requested resource was not found." },
      requestId: "corr-000001",
    });
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("returns 405 for %s /healthz", async (method) => {
    const response = await fetchFrom(testWorker(), new Request("http://jobs/healthz", { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("corr-000001");
    if (method !== "HEAD") {
      expect(await response.json()).toEqual({
        error: { code: "method_not_allowed", message: "The request method is not allowed." },
        requestId: "corr-000001",
      });
    }
  });

  it("answers /healthz through the default export", async () => {
    const response = await fetchFrom(worker, new Request("http://jobs/healthz"));
    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });
});
