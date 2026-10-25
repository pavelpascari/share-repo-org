import { env } from "cloudflare:workers";
import { grantManualAccess } from "@sharerepo/application";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { captureLogs, type LogCapture } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import { DAY, entitlementsOf, type Shop, shop } from "./support/commerce.ts";
import { clock, envWithGitHub, serviceContext } from "./support/github.ts";
import { jobsWorker, runCron } from "./support/worker.ts";

// Manual access timers at the cron entry point (decision 0016): the minute tick evaluates due
// manual accesses itself, before the drain runs the reconciles they request.

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);

const tick = (s: Shop, bindings: Env = envWithGitHub) =>
  runCron(jobsWorker(s.github), CRONS.drainOutbox, bindings);

async function grantedUntil(s: Shop, endsAt: number) {
  const user = {
    id: String(Math.floor(Math.random() * 1e9)),
    login: `m-${crypto.randomUUID().slice(0, 8)}`,
    type: "User" as const,
  };
  s.github.addUser(user);
  const result = await grantManualAccess(
    serviceContext(),
    s,
    s.slug,
    { offerId: s.offerId, githubLogin: user.login, endsAt, note: "" },
    { github: s.github },
  );
  if (!result.ok) throw new Error(result.error);
  return { user, id: result.manualAccessId };
}

describe("manual/end-date-expires-via-sweep (entry point)", () => {
  it("manual/end-date-expires-via-sweep: the minute tick ends access at the end date and revokes the invitation", async () => {
    const s = await shop(createFakeGitHubApp({ clock }));
    const endsAt = clock.now() + DAY;
    const { user } = await grantedUntil(s, endsAt);
    await tick(s);
    const repo = (
      (await env.DB.prepare("SELECT name_snapshot AS name FROM resources WHERE workspace_id = ?")
        .bind(s.workspaceId)
        .first<{ name: string }>()) as { name: string }
    ).name;
    expect(s.github.repositoryAccess(repo).invitations).toEqual([
      expect.objectContaining({ inviteeId: user.id }),
    ]);
    clock.set(endsAt + 30_000);
    await tick(s);
    expect(await entitlementsOf(s)).toMatchObject([
      { state: "expired", decisionReason: "manual_ended" },
    ]);
    await tick(s);
    expect(s.github.repositoryAccess(repo).invitations).toEqual([]);
    const heartbeat = logged().find(
      (line) => line.msg === "sweep.heartbeat" && Number(line.manualAccessesEvaluated) > 0,
    );
    expect(heartbeat).toBeDefined();
  });

  it("logs a failing manual access sweep by classification and still drains", async () => {
    const s = await shop(createFakeGitHubApp({ clock }));
    const broken = new Proxy(env.DB, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "prepare" && String(args[0]).includes('from "manual_accesses"')) {
            throw new Error("d1 unavailable (test)");
          }
          return value.apply(target, args);
        };
      },
    });
    await tick(s, { ...envWithGitHub, DB: broken });
    expect(logged()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "manual access sweep failed", errorName: "Error" }),
      ]),
    );
  });

  it("warns about evaluations that failed, which stay due", async () => {
    const s = await shop(createFakeGitHubApp({ clock }));
    const endsAt = clock.now() + DAY;
    await grantedUntil(s, endsAt);
    clock.set(endsAt + 1);
    let batches = 0;
    const flaky = new Proxy(env.DB, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          // The evaluation's write is the tick's first batch.
          if (property === "batch" && batches++ === 0) {
            return Promise.reject(new Error("d1 unavailable (test)"));
          }
          return value.apply(target, args);
        };
      },
    });
    await tick(s, { ...envWithGitHub, DB: flaky });
    expect(logged()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "manual access evaluations failed", failed: 1 }),
      ]),
    );
  });
});
