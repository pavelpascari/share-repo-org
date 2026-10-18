import { env } from "cloudflare:workers";
import { listAuditEventsByCorrelationId, listAuditEventsForWorkspace } from "@sharerepo/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { expectAuditedChange, expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  createWorkspace,
  listMyWorkspaces,
  openWorkspace,
  renameWorkspace,
  type UserActor,
  type WorkspaceSummary,
} from "../src/index.ts";
import { db, serviceContext, signedUpUser, uniqueSlug } from "./support/context.ts";

async function workspaceOf(owner: UserActor, name = "Acme"): Promise<WorkspaceSummary> {
  const result = await createWorkspace(serviceContext(), owner, { name, slug: uniqueSlug() });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.workspace;
}

async function withMember(workspace: WorkspaceSummary, owner: UserActor) {
  const member = await signedUpUser();
  await addWorkspaceMember(serviceContext(), owner, workspace.slug, {
    userId: member.userId,
    role: "member",
  });
  return member;
}

const setStatus = (workspaceId: string, status: string) =>
  env.DB.prepare("UPDATE workspaces SET status = ? WHERE id = ?").bind(status, workspaceId).run();

describe("createWorkspace", () => {
  it("creates the workspace and owner membership with audit events", async () => {
    const owner = await signedUpUser();
    const ctx = serviceContext();
    const slug = uniqueSlug();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createWorkspace(ctx, owner, { name: "  Acme Labs ", slug: `  ${slug.toUpperCase()} ` }),
    );
    expect(result).toEqual({
      ok: true,
      workspace: {
        id: expect.any(String),
        slug,
        name: "Acme Labs",
        status: "active",
        role: "owner",
      },
    });
    expect(changedTables).toEqual(["workspace_memberships", "workspaces"]);
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events).toMatchObject([
      { action: "workspace.created", details: { slug, name: "Acme Labs" } },
      { action: "membership.added", target: { id: owner.userId }, details: { role: "owner" } },
    ]);
  });

  it("reports every invalid field and writes nothing", async () => {
    const owner = await signedUpUser();
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createWorkspace(ctx, owner, { name: " ", slug: "x" }),
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        { field: "name", code: "name_empty" },
        { field: "slug", code: "slug_too_short" },
      ],
    });
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toEqual([]);
  });

  it("reports one invalid field when the other is valid", async () => {
    const owner = await signedUpUser();
    const result = await createWorkspace(serviceContext(), owner, {
      name: "Acme",
      slug: "Not A Slug",
    });
    expect(result).toEqual({ ok: false, errors: [{ field: "slug", code: "slug_invalid_format" }] });
  });

  it("reports a taken slug as a field error and writes nothing", async () => {
    const owner = await signedUpUser();
    const existing = await workspaceOf(owner);
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createWorkspace(ctx, owner, { name: "Other", slug: existing.slug }),
    );
    expect(result).toEqual({ ok: false, errors: [{ field: "slug", code: "slug_taken" }] });
  });
});

describe("listMyWorkspaces", () => {
  it("lists only the actor's workspaces, with roles, by name", async () => {
    const owner = await signedUpUser();
    const zeta = await workspaceOf(owner, "Zeta");
    const alpha = await workspaceOf(owner, "Alpha");
    const stranger = await signedUpUser();
    const theirs = await workspaceOf(stranger, "Beta");
    await addWorkspaceMember(serviceContext(), stranger, theirs.slug, {
      userId: owner.userId,
      role: "member",
    });
    expect(await listMyWorkspaces(serviceContext(), owner)).toEqual([
      alpha,
      { ...theirs, role: "member" },
      zeta,
    ]);
    expect(await listMyWorkspaces(serviceContext(), await signedUpUser())).toEqual([]);
  });
});

describe("openWorkspace", () => {
  it.each([
    ["owner", "workspace.read", true],
    ["owner", "workspace.manage", true],
    ["member", "workspace.read", true],
    ["member", "workspace.manage", false],
  ] as const)("%s with %s → allowed: %s", async (role, permission, allowed) => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    const actor = role === "owner" ? owner : await withMember(workspace, owner);
    const opening = openWorkspace(serviceContext(), actor, workspace.slug, permission);
    if (allowed) {
      await expect(opening).resolves.toMatchObject({
        scope: { workspaceId: workspace.id, userId: actor.userId, role },
        workspace: { ...workspace, role },
      });
    } else {
      await expect(opening).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("finds a workspace by a differently cased slug", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    await expect(
      openWorkspace(serviceContext(), owner, workspace.slug.toUpperCase(), "workspace.read"),
    ).resolves.toMatchObject({ workspace });
  });

  it.each(["no-such-workspace", "Not A Slug"])("treats %j as not found", async (slug) => {
    const owner = await signedUpUser();
    await expect(
      openWorkspace(serviceContext(), owner, slug, "workspace.read"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("allows reading but not changing a suspended workspace", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    await setStatus(workspace.id, "suspended");
    await expect(
      openWorkspace(serviceContext(), owner, workspace.slug, "workspace.read"),
    ).resolves.toMatchObject({ workspace: { status: "suspended" } });
    await expect(
      openWorkspace(serviceContext(), owner, workspace.slug, "workspace.manage"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("renameWorkspace", () => {
  it("renames with a workspace.renamed audit event", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner, "Before");
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      renameWorkspace(ctx, owner, workspace.slug, { name: " After " }),
    );
    expect(result).toEqual({ ok: true, workspace: { ...workspace, name: "After" } });
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      { action: "workspace.renamed", details: { previousName: "Before", name: "After" } },
    ]);
  });

  it("treats an unchanged name as a no-op that writes nothing", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    const ctx = serviceContext();
    const { result, changedTables, auditEventCount } = await expectAuditedChange(
      env.DB,
      ctx.correlationId,
      () => renameWorkspace(ctx, owner, workspace.slug, { name: workspace.name }),
    );
    expect(result).toEqual({ ok: true, workspace });
    expect([changedTables, auditEventCount]).toEqual([[], 0]);
  });

  it("rejects an invalid name as a field error", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    await expect(
      renameWorkspace(serviceContext(), owner, workspace.slug, { name: "" }),
    ).resolves.toEqual({ ok: false, errors: [{ field: "name", code: "name_empty" }] });
  });

  it("forbids a member from renaming", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    const member = await withMember(workspace, owner);
    const error = await expectNoChangeOnFailure(env.DB, () =>
      renameWorkspace(serviceContext(), member, workspace.slug, { name: "Taken over" }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

describe("addWorkspaceMember", () => {
  it("adds a member with a membership.added audit event", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    const member = await signedUpUser();
    const ctx = serviceContext();
    await expectAuditedChange(env.DB, ctx.correlationId, () =>
      addWorkspaceMember(ctx, owner, workspace.slug, { userId: member.userId, role: "member" }),
    );
    const events = await listAuditEventsForWorkspace(db, workspace.id);
    expect(events.at(-1)).toMatchObject({
      action: "membership.added",
      actor: { id: owner.userId },
      target: { id: member.userId },
      details: { role: "member" },
    });
  });

  it("reports an existing member as a conflict and writes nothing", async () => {
    const owner = await signedUpUser();
    const workspace = await workspaceOf(owner);
    const error = await expectNoChangeOnFailure(env.DB, () =>
      addWorkspaceMember(serviceContext(), owner, workspace.slug, {
        userId: owner.userId,
        role: "member",
      }),
    );
    expect(error).toBeInstanceOf(ConflictError);
  });
});
