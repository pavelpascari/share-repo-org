import { env } from "cloudflare:workers";
import { getWorkspace } from "@sharerepo/db";
import type { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import * as me from "../app/routes/me.tsx";
import * as exporting from "../app/routes/w.$slug.export.ts";
import * as settings from "../app/routes/w.$slug.settings.tsx";
import {
  get,
  harness,
  memberOf,
  post,
  type Shop,
  type SignedIn,
  shop,
  signedIn,
  thrownStatus,
} from "./support/shop.ts";
import { db, sessionUser } from "./support/sign-in.ts";

// Workspace settings (export, delete, cancel) and the account page (decision 0015), called as
// React Router would, against local D1.

const args = (request: Request, s: Shop, context: RouterContextProvider) =>
  ({ request, params: { slug: s.slug }, context }) as never;
const meArgs = (request: Request, context: RouterContextProvider) =>
  ({ request, params: {}, context }) as never;

const EVIL = "https://evil.example";

async function count(query: string, ...params: unknown[]) {
  const row = await env.DB.prepare(query)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n);
}

const requestDeletion = (s: Shop, context: RouterContextProvider, confirmation = s.slug) =>
  settings.action(
    args(post(`/w/${s.slug}/settings`, s.owner, { intent: "delete", confirmation }), s, context),
  );

describe("workspace settings", () => {
  it("are the owner's: members are forbidden and other workspaces are not found", async () => {
    const s = await shop();
    const member = await memberOf(s);
    const stranger = await signedIn();
    const { context } = harness();
    const path = `/w/${s.slug}/settings`;
    expect(await settings.loader(args(get(path, s.owner), s, context))).toMatchObject({
      workspace: { slug: s.slug, status: "active" },
      deletion: null,
    });
    expect(await thrownStatus(settings.loader(args(get(path, member), s, context)))).toBe(403);
    expect(await thrownStatus(settings.loader(args(get(path, stranger), s, context)))).toBe(404);
    // A stranger's post is not found before its form is even read.
    expect(
      await thrownStatus(settings.action(args(post(path, stranger, { intent: "x" }), s, context))),
    ).toBe(404);
    expect(
      await thrownStatus(
        settings.action(
          args(post(path, member, { intent: "delete", confirmation: s.slug }), s, context),
        ),
      ),
    ).toBe(403);
    expect(
      await thrownStatus(settings.action(args(post(path, s.owner, { intent: "x" }), s, context))),
    ).toBe(400);
  });

  it("renames, also from a form without an intent", async () => {
    const s = await shop();
    const { context } = harness();
    const path = `/w/${s.slug}/settings`;
    expect(
      await settings.action(args(post(path, s.owner, { name: "Renamed" }), s, context)),
    ).toEqual({
      intent: "rename",
      saved: true,
      errors: {},
    });
    expect(
      await settings.action(args(post(path, s.owner, { intent: "rename", name: " " }), s, context)),
    ).toMatchObject({ intent: "rename", saved: false, errors: { name: "Enter a name." } });
  });

  it("deletes after the slug is typed, shows the schedule, and cancels", async () => {
    const s = await shop();
    const { context } = harness();
    expect(await requestDeletion(s, context, "wrong")).toEqual({
      intent: "delete",
      ok: false,
      error: "Type the workspace's URL name exactly to confirm.",
      orphanedDestinationId: null,
    });
    expect(await requestDeletion(s, context)).toEqual({
      intent: "delete",
      ok: true,
      error: null,
      orphanedDestinationId: null,
    });
    const deleting = await getWorkspace(db, s.workspaceId);
    expect(deleting?.status).toBe("deleting");
    const loaded = await settings.loader(args(get(`/w/${s.slug}/settings`, s.owner), s, context));
    expect(loaded.deletion).toEqual({ deleteAfter: deleting?.deleteAfter, blocked: null });
    // Read-only now: renaming is forbidden, a second deletion is not offered.
    expect(
      await thrownStatus(
        settings.action(args(post(`/w/${s.slug}/settings`, s.owner, { name: "X" }), s, context)),
      ),
    ).toBe(403);

    const cancel = () =>
      settings.action(
        args(post(`/w/${s.slug}/settings`, s.owner, { intent: "cancel_deletion" }), s, context),
      );
    expect(await cancel()).toEqual({ intent: "cancel_deletion", ok: true });
    expect((await getWorkspace(db, s.workspaceId))?.status).toBe("active");
    expect(await cancel()).toEqual({ intent: "cancel_deletion", ok: false });
    expect(await requestDeletion(s, context)).toMatchObject({ ok: true });
    // Already deleting: the workspace refuses changes.
    expect(await thrownStatus(requestDeletion(s, context))).toBe(403);
  });
});

describe("workspace export route", () => {
  it("downloads the owner's export as a JSON attachment", async () => {
    const s = await shop();
    const { context } = harness();
    const response = (await exporting.action(
      args(post(`/w/${s.slug}/export`, s.owner, {}), s, context),
    )) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      new RegExp(`^attachment; filename="sharerepo-${s.slug}-\\d{4}-\\d{2}-\\d{2}\\.json"$`),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const document = (await response.json()) as { workspace: { id: string } };
    expect(document.workspace.id).toBe(s.workspaceId);
  });

  it("is the owner's, POST only, and rate limited", async () => {
    const s = await shop();
    const member = await memberOf(s);
    const { context } = harness();
    const path = `/w/${s.slug}/export`;
    expect(await thrownStatus(exporting.action(args(post(path, member, {}), s, context)))).toBe(
      403,
    );
    expect(
      await thrownStatus(exporting.action(args(post(path, await signedIn(), {}), s, context))),
    ).toBe(404);
    expect(await thrownStatus(Promise.resolve().then(() => exporting.loader()))).toBe(405);
    for (let i = 0; i < 5; i += 1) {
      await exporting.action(args(post(path, s.owner, {}), s, context));
    }
    const limited = await exporting
      .action(args(post(path, s.owner, {}), s, context))
      .catch(
        (error: unknown) => error as { init: { status: number; headers: Record<string, string> } },
      );
    expect((limited as { init: { status: number } }).init.status).toBe(429);
    expect(
      Number(
        (limited as { init: { headers: Record<string, string> } }).init.headers["retry-after"],
      ),
    ).toBeGreaterThan(0);
  });
});

describe("account page", () => {
  const deleteAccount = (who: SignedIn, context: RouterContextProvider, confirmation = who.login) =>
    me.action(meArgs(post("/me", who, { intent: "delete", confirmation }), context));

  it("lists the workspaces that block a deletion, and refuses it", async () => {
    const s = await shop();
    const { context } = harness();
    expect(await me.loader(meArgs(get("/me", s.owner), context))).toEqual({
      login: s.owner.login,
      blockingWorkspaces: [{ slug: s.slug, name: "Shop", status: "active" }],
    });
    expect(await deleteAccount(s.owner, context)).toEqual({
      error: "Delete the workspaces you own first.",
    });
    expect(await sessionUser(s.owner.cookie)).not.toBeNull();
  });

  it("deletes the account after the login is typed, and signs the user out", async () => {
    const user = await signedIn();
    const { context } = harness();
    expect(await deleteAccount(user, context, "someone-else")).toEqual({
      error: "Type your GitHub login exactly to confirm.",
    });
    const response = (await deleteAccount(user, context).catch((e: unknown) => e)) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?account=deleted");
    const cleared = response.headers.getSetCookie();
    expect(cleared.some((cookie) => cookie.startsWith("sharerepo.session_token=;"))).toBe(true);
    expect(await sessionUser(user.cookie)).toBeNull();
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", user.userId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM auth_users WHERE id = ?", user.userId)).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'user.deleted' AND target_id = ?",
        user.userId,
      ),
    ).toBe(1);
  });

  it("rejects a malformed form", async () => {
    const user = await signedIn();
    const { context } = harness();
    expect(
      await thrownStatus(me.action(meArgs(post("/me", user, { intent: "other" }), context))),
    ).toBe(400);
  });
});

describe("deletion/cross-site-request-refused", () => {
  it("refuses cross-origin deletion, cancellation, export and account deletion", async () => {
    const s = await shop();
    const { context } = harness();
    const path = `/w/${s.slug}/settings`;
    expect(
      await thrownStatus(
        settings.action(
          args(post(path, s.owner, { intent: "delete", confirmation: s.slug }, EVIL), s, context),
        ),
      ),
    ).toBe(403);
    expect((await getWorkspace(db, s.workspaceId))?.status).toBe("active");
    expect(
      await thrownStatus(
        exporting.action(args(post(`/w/${s.slug}/export`, s.owner, {}, EVIL), s, context)),
      ),
    ).toBe(403);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'workspace.exported' AND workspace_id = ?",
        s.workspaceId,
      ),
    ).toBe(0);

    await requestDeletion(s, context);
    expect(
      await thrownStatus(
        settings.action(args(post(path, s.owner, { intent: "cancel_deletion" }, EVIL), s, context)),
      ),
    ).toBe(403);
    expect((await getWorkspace(db, s.workspaceId))?.status).toBe("deleting");

    expect(
      await thrownStatus(
        me.action(
          meArgs(
            post("/me", s.owner, { intent: "delete", confirmation: s.owner.login }, EVIL),
            context,
          ),
        ),
      ),
    ).toBe(403);
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", s.owner.userId)).toBe(1);
    expect(await sessionUser(s.owner.cookie)).not.toBeNull();
  });
});
