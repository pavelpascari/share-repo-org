import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

describe("jobs worker", () => {
  it("answers /healthz", async () => {
    const response = await worker.fetch(
      new Request("http://jobs/healthz"),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await worker.fetch(
      new Request("http://jobs/nope"),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
  });

  it("runs the scheduled handler", async () => {
    await expect(
      worker.scheduled(
        createScheduledController({ cron: "0 * * * *" }),
        env,
        createExecutionContext(),
      ),
    ).resolves.toBeUndefined();
  });
});
