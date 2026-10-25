import { env } from "cloudflare:workers";
import { recordJobFailure } from "@sharerepo/application";
import { enqueueOutbox, listAuditEventsByCorrelationId, recordPurgeBlocked } from "@sharerepo/db";
import { systemClock } from "@sharerepo/domain";
import type { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/context.ts";
import * as ops from "../app/routes/ops.tsx";
import * as opsWorkspace from "../app/routes/ops.w.$slug.tsx";
import * as access from "../app/routes/w.$slug.access.tsx";
import {
  get,
  harness,
  post,
  type Shop,
  type SignedIn,
  services,
  shop,
  signedIn,
  signedInAs,
  thrownStatus,
} from "./support/shop.ts";
import { db } from "./support/sign-in.ts";

// `/ops`, its read-only workspace view, and the owner's failures on the Access page (decision
// 0014), called as React Router would, against local D1.

const args = (request: Request, context: RouterContextProvider, slug?: string) =>
  ({ request, params: slug === undefined ? {} : { slug }, context }) as never;

/** A harness in which `who` is an operator. */
const asOperator = (who: SignedIn) =>
  harness({ env: { OPERATOR_GITHUB_IDS: `1, ${who.githubId}` } });

/** A failed job of the shop's workspace (null: system-wide). */
async function failedJob(workspaceId: string | null, subjectId: string): Promise<string> {
  const id = `obx-${crypto.randomUUID()}`;
  const now = systemClock.now();
  await enqueueOutbox(db, {
    id,
    kind: "resync_connection",
    subjectId,
    createdAt: now,
    availableAt: now,
    workspaceId,
  });
  if (!(await recordJobFailure(services(), { outboxId: id, errorCode: "rejected" }))) {
    throw new Error("setup failed");
  }
  return id;
}

/** The `/ops` lists of a loader result that read them. */
function listsOf<T>(loaded: { lists: T | null }): T {
  if (loaded.lists === null) throw new Error("expected the lists");
  return loaded.lists;
}

const connectionOf = async (s: Shop) => s.resources[0]?.connectionId as string;

describe("operator/non-operator-gets-404", () => {
  it("answers 404 to signed-out visitors and non-operators, on every operator route", async () => {
    const s = await shop();
    const operator = await signedIn();
    const someone = await signedIn();
    const anonymous = { ...someone, cookie: "" };
    for (const who of [anonymous, someone, s.owner]) {
      const { context } = asOperator(operator);
      expect(await thrownStatus(ops.loader(args(get("/ops", who), context)))).toBe(404);
      expect(
        await thrownStatus(
          ops.action(
            args(post("/ops", who, { intent: "retry", outboxId: "x", workspaceId: "" }), context),
          ),
        ),
      ).toBe(404);
      expect(
        await thrownStatus(
          opsWorkspace.loader(args(get(`/ops/w/${s.slug}`, who), context, s.slug)),
        ),
      ).toBe(404);
    }
    // Without configured operators, nobody is one.
    const { context } = harness();
    expect(await thrownStatus(ops.loader(args(get("/ops", operator), context)))).toBe(404);
  });
});

describe("/ops", () => {
  it("lists every workspace's failures for an operator", async () => {
    const s = await shop();
    const operator = await signedIn();
    const job = await failedJob(s.workspaceId, await connectionOf(s));
    const system = await failedJob(null, "x");
    const { context } = asOperator(operator);
    const loaded = listsOf(await ops.loader(args(get("/ops", operator), context)));
    expect(loaded.jobs.map((j) => j.id)).toEqual(expect.arrayContaining([job, system]));
    expect(loaded.sweep).toHaveProperty("lastHeartbeatAt");
    expect(typeof loaded.now).toBe("number");
  });

  it("retries and dismisses, audited with the operator as actor, and refuses bad forms", async () => {
    const s = await shop();
    const operator = await signedIn();
    const job = await failedJob(s.workspaceId, await connectionOf(s));
    const h = asOperator(operator);
    const correlationId = h.context.get(cloudflareContext).correlationId;

    const dismissedBlank = await ops.action(
      args(
        post("/ops", operator, {
          intent: "dismiss",
          outboxId: job,
          workspaceId: s.workspaceId,
          reason: " ",
        }),
        h.context,
      ),
    );
    expect(dismissedBlank).toMatchObject({ ok: false, error: expect.stringContaining("why") });

    const dismissed = await ops.action(
      args(
        post("/ops", operator, {
          intent: "dismiss",
          outboxId: job,
          workspaceId: s.workspaceId,
          reason: "Known GitHub outage",
        }),
        h.context,
      ),
    );
    expect(dismissed).toEqual({ ok: true, notice: "Dismissed.", error: null, outboxId: job });

    const retried = await ops.action(
      args(
        post("/ops", operator, { intent: "retry", outboxId: job, workspaceId: s.workspaceId }),
        h.context,
      ),
    );
    expect(retried).toMatchObject({ ok: true, notice: "Retry queued." });
    await h.settle();
    expect(h.sent).toEqual([
      { outboxId: job, kind: "resync_connection", subjectId: await connectionOf(s) },
    ]);
    const events = await listAuditEventsByCorrelationId(db, correlationId);
    expect(events.map((e) => [e.action, e.actor.type])).toEqual([
      ["job.dismissed", "operator"],
      ["job.retried", "operator"],
    ]);

    // No longer a failure: retrying again says so instead of failing the page.
    const stale = await ops.action(
      args(
        post("/ops", operator, { intent: "retry", outboxId: job, workspaceId: s.workspaceId }),
        h.context,
      ),
    );
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("no longer open") });
    const unreadable = await ops.action(
      args(post("/ops", operator, { intent: "explode", outboxId: job }), h.context),
    );
    expect(unreadable).toMatchObject({ ok: false, outboxId: null });
  });

  it("refuses a cross-site form", async () => {
    const operator = await signedIn();
    const { context } = asOperator(operator);
    const request = post(
      "/ops",
      operator,
      { intent: "retry", outboxId: "x", workspaceId: "" },
      "https://evil.example",
    );
    expect(await thrownStatus(ops.action(args(request, context)))).toBe(403);
  });

  it("treats a failure of an unknown workspace as no longer open", async () => {
    const operator = await signedIn();
    const { context } = asOperator(operator);
    const missing = await ops.action(
      args(post("/ops", operator, { intent: "retry", outboxId: "x", workspaceId: "ws" }), context),
    );
    expect(missing).toMatchObject({ ok: false, outboxId: "x" });
  });
});

describe("/ops/w/:slug", () => {
  it("shows a workspace read-only and audits the visit", async () => {
    const s = await shop();
    const operator = await signedIn();
    const h = asOperator(operator);
    const loaded = await opsWorkspace.loader(
      args(get(`/ops/w/${s.slug}`, operator), h.context, s.slug),
    );
    expect(loaded.workspace.id).toBe(s.workspaceId);
    expect(loaded.access.canManage).toBe(false);
    const correlationId = h.context.get(cloudflareContext).correlationId;
    expect(
      (await listAuditEventsByCorrelationId(db, correlationId)).map((e) => [
        e.action,
        e.actor.type,
        e.workspaceId,
      ]),
    ).toEqual([["operator.viewed_workspace", "operator", s.workspaceId]]);
    expect(
      await thrownStatus(
        opsWorkspace.loader(args(get("/ops/w/ws-nope", operator), h.context, "ws-nope")),
      ),
    ).toBe(404);
  });
});

describe("/ops/w/:slug from another site", () => {
  it("redirects a cross-site or same-site navigation to /ops, writing no audit event", async () => {
    const s = await shop();
    const operator = await signedIn();
    for (const site of ["cross-site", "same-site"]) {
      const h = asOperator(operator);
      const request = get(`/ops/w/${s.slug}`, operator);
      request.headers.set("sec-fetch-site", site);
      const thrown = await opsWorkspace.loader(args(request, h.context, s.slug)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("location")).toBe("/ops");
      const correlationId = h.context.get(cloudflareContext).correlationId;
      expect(await listAuditEventsByCorrelationId(db, correlationId)).toEqual([]);
    }
    // A typed URL or our own link opens it.
    for (const site of ["none", "same-origin"]) {
      const request = get(`/ops/w/${s.slug}`, operator);
      request.headers.set("sec-fetch-site", site);
      const loaded = await opsWorkspace.loader(args(request, asOperator(operator).context, s.slug));
      expect(loaded.workspace.id).toBe(s.workspaceId);
    }
  });

  it("operator/list-views-audited: /ops audits each view, and a cross-site navigation reads and writes nothing", async () => {
    const operator = await signedIn();
    for (const site of ["cross-site", "same-site"]) {
      const h = asOperator(operator);
      const request = get("/ops", operator);
      request.headers.set("sec-fetch-site", site);
      expect(await ops.loader(args(request, h.context))).toEqual({ lists: null });
      const correlationId = h.context.get(cloudflareContext).correlationId;
      expect(await listAuditEventsByCorrelationId(db, correlationId)).toEqual([]);
    }
    for (const site of ["none", "same-origin"]) {
      const h = asOperator(operator);
      const request = get("/ops", operator);
      request.headers.set("sec-fetch-site", site);
      const loaded = listsOf(await ops.loader(args(request, h.context)));
      const correlationId = h.context.get(cloudflareContext).correlationId;
      expect(await listAuditEventsByCorrelationId(db, correlationId)).toMatchObject([
        {
          action: "operator.viewed_failures",
          scope: "account",
          actor: { type: "operator", id: operator.userId },
          correlationId,
          details: { jobs: loaded.jobs.length },
        },
      ]);
    }
  });

  it("operator/mutation-needs-fresh-session: an old session must sign in again to retry or dismiss", async () => {
    const s = await shop();
    const operator = await signedIn();
    const job = await failedJob(s.workspaceId, await connectionOf(s));
    // The operator signed in three hours ago.
    await env.DB.prepare("UPDATE auth_sessions SET created_at = ? WHERE user_id = ?")
      .bind(systemClock.now() - 3 * 60 * 60 * 1000, operator.userId)
      .run();
    for (const fields of [
      { intent: "retry", outboxId: job, workspaceId: s.workspaceId },
      { intent: "dismiss", outboxId: job, workspaceId: s.workspaceId, reason: "Known outage" },
    ]) {
      const h = asOperator(operator);
      const result = await ops.action(args(post("/ops", operator, fields), h.context));
      expect(result).toMatchObject({ ok: false, reauthenticate: true, outboxId: job });
      const correlationId = h.context.get(cloudflareContext).correlationId;
      expect(await listAuditEventsByCorrelationId(db, correlationId)).toEqual([]);
      expect(h.sent).toEqual([]);
    }
    const open = await env.DB.prepare("SELECT failed_at, dismissed_at FROM outbox WHERE id = ?")
      .bind(job)
      .first<{ failed_at: number | null; dismissed_at: number | null }>();
    expect(open).toMatchObject({ failed_at: expect.any(Number), dismissed_at: null });
    // Signing in again (a new session) makes it fresh: the retry goes through.
    const again = await signedInAs(operator);
    const h = asOperator(again);
    expect(
      await ops.action(
        args(
          post("/ops", again, { intent: "retry", outboxId: job, workspaceId: s.workspaceId }),
          h.context,
        ),
      ),
    ).toMatchObject({ ok: true });
  });

  it("still answers 404 to a non-operator first", async () => {
    const s = await shop();
    const operator = await signedIn();
    const someone = await signedIn();
    const request = get(`/ops/w/${s.slug}`, someone);
    request.headers.set("sec-fetch-site", "cross-site");
    expect(
      await thrownStatus(opsWorkspace.loader(args(request, asOperator(operator).context, s.slug))),
    ).toBe(404);
  });
});

describe("owner failures on the Access page", () => {
  it("failure/owner-sees-only-own-failures: lists and retries the owner's own failures only", async () => {
    const mine = await shop();
    const theirs = await shop();
    const own = await failedJob(mine.workspaceId, await connectionOf(mine));
    const other = await failedJob(theirs.workspaceId, await connectionOf(theirs));
    const h = harness();
    const loaded = await access.loader(
      args(get(`/w/${mine.slug}/access`, mine.owner), h.context, mine.slug),
    );
    expect(loaded.failures.jobs.map((job) => job.id)).toEqual([own]);
    expect(loaded.failures.canRetry).toBe(true);

    // Another workspace's failure, named through mine, is not found.
    expect(
      await thrownStatus(
        access.action(
          args(
            post(`/w/${mine.slug}/access`, mine.owner, { intent: "retry-job", outboxId: other }),
            h.context,
            mine.slug,
          ),
        ),
      ),
    ).toBe(404);
    const retried = await access.action(
      args(
        post(`/w/${mine.slug}/access`, mine.owner, { intent: "retry-job", outboxId: own }),
        h.context,
        mine.slug,
      ),
    );
    expect(retried).toEqual({ ok: true, notice: "Retry queued.", error: null });
    await h.settle();
    expect(h.sent).toEqual([
      { outboxId: own, kind: "resync_connection", subjectId: await connectionOf(mine) },
    ]);
    const after = await access.loader(
      args(get(`/w/${mine.slug}/access`, mine.owner), harness().context, mine.slug),
    );
    expect(after.failures.jobs).toEqual([]);
  });
});

describe("purges that wait", () => {
  it("shows a workspace's recorded purge block to its owner and on /ops, and no one else's", async () => {
    const mine = await shop();
    const theirs = await shop();
    const operator = await signedIn();
    const since = systemClock.now();
    await recordPurgeBlocked(db, {
      workspaceId: mine.workspaceId,
      reason: "managed_access_remaining",
      now: since,
    });
    await recordPurgeBlocked(db, {
      workspaceId: mine.workspaceId,
      reason: "managed_access_remaining",
      now: since + 1,
    });
    const block = {
      workspaceId: mine.workspaceId,
      workspaceSlug: mine.slug,
      workspaceName: expect.any(String),
      reason: "managed_access_remaining",
      since,
      checkedAt: since + 1,
    };

    const own = await access.loader(
      args(get(`/w/${mine.slug}/access`, mine.owner), harness().context, mine.slug),
    );
    expect(own.failures.purgeBlocked).toEqual(block);
    const other = await access.loader(
      args(get(`/w/${theirs.slug}/access`, theirs.owner), harness().context, theirs.slug),
    );
    expect(other.failures.purgeBlocked).toBeNull();

    const { context } = asOperator(operator);
    const loaded = listsOf(await ops.loader(args(get("/ops", operator), context)));
    expect(loaded.purgesBlocked).toContainEqual(block);
    expect(loaded.purgesBlocked.map((b) => b.workspaceId)).not.toContain(theirs.workspaceId);
    const viewed = await opsWorkspace.loader(
      args(get(`/ops/w/${mine.slug}`, operator), asOperator(operator).context, mine.slug),
    );
    expect(viewed.failures.purgeBlocked).toEqual(block);
  });
});
