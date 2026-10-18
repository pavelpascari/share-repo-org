import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { enqueueJob } from "../app/jobs.server.ts";
import { requestContext } from "./support/request-context.ts";

function setup(send: (message: unknown) => Promise<void>) {
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const ctx = createExecutionContext();
  const context = requestContext({
    ctx,
    rawEnv: { ...env, EVENTS: { send } },
    sink: { debug: record, info: record, warn: record, error: record },
  });
  return { context, ctx, logs: () => lines.map((line) => JSON.parse(line)) };
}

const message = {
  kind: "refresh_subscription",
  subjectId: "w:simulated:s",
  outboxId: "o1",
} as const;

describe("enqueueJob", () => {
  it("sends the message after the response, through waitUntil", async () => {
    const sent: unknown[] = [];
    const { context, ctx, logs } = setup(async (m) => {
      sent.push(m);
    });
    enqueueJob(context, message);
    await waitOnExecutionContext(ctx);
    expect(sent).toEqual([message]);
    expect(logs()).toEqual([]);
  });

  it.each([
    ["rejects", () => Promise.reject(new TypeError("queue down: token=hunter2"))],
    [
      "throws synchronously",
      () => {
        throw "not an error";
      },
    ],
  ])("logs a classification only when the send %s", async (_, send) => {
    const { context, ctx, logs } = setup(send as () => Promise<void>);
    expect(() => enqueueJob(context, message)).not.toThrow();
    await waitOnExecutionContext(ctx);
    const [line] = logs();
    expect(line).toMatchObject({
      level: "warn",
      msg: "queue send failed; the outbox drain will deliver",
      outboxId: "o1",
      kind: "refresh_subscription",
    });
    expect(["TypeError", "unknown"]).toContain(line.errorName);
    expect(JSON.stringify(logs())).not.toContain("hunter2");
  });
});
