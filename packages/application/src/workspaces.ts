import * as repo from "@sharerepo/db";
import {
  auditEvent,
  authorizeMembership,
  parseWorkspaceName,
  parseWorkspaceSlug,
  type WorkspaceNameError,
  type WorkspacePermission,
  type WorkspaceRole,
  type WorkspaceScope,
  type WorkspaceSlugError,
  type WorkspaceStatus,
} from "@sharerepo/domain";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { asAuditActor, type ServiceContext, type UserActor } from "./context.ts";

/** What a member sees of a workspace. */
export interface WorkspaceSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly role: WorkspaceRole;
}

export type WorkspaceFieldError =
  | { readonly field: "slug"; readonly code: WorkspaceSlugError | "slug_taken" }
  | { readonly field: "name"; readonly code: WorkspaceNameError };

export type WorkspaceResult =
  | { readonly ok: true; readonly workspace: WorkspaceSummary }
  | { readonly ok: false; readonly errors: readonly WorkspaceFieldError[] };

const summary = (found: repo.WorkspaceForMember): WorkspaceSummary => ({
  id: found.workspace.id,
  slug: found.workspace.slug,
  name: found.workspace.name,
  status: found.workspace.status,
  role: found.role,
});

/** Creates a workspace owned by the actor. Invalid or taken values come back as field errors. */
export async function createWorkspace(
  ctx: ServiceContext,
  actor: UserActor,
  input: { readonly name: string; readonly slug: string },
): Promise<WorkspaceResult> {
  const name = parseWorkspaceName(input.name);
  const slug = parseWorkspaceSlug(input.slug);
  const errors: WorkspaceFieldError[] = [];
  if (!name.ok) errors.push({ field: "name", code: name.error });
  if (!slug.ok) errors.push({ field: "slug", code: slug.error });
  if (!name.ok || !slug.ok) return { ok: false, errors };

  const id = ctx.ids.next();
  const by = asAuditActor(actor);
  const result = await repo.createWorkspace(
    ctx.db,
    { id, ownerUserId: actor.userId, slug: slug.value, name: name.value, now: ctx.clock.now() },
    [
      auditEvent(
        "workspace.created",
        {
          workspaceId: id,
          actor: by,
          targetId: id,
          details: { slug: slug.value, name: name.value },
        },
        ctx,
      ),
      auditEvent(
        "membership.added",
        { workspaceId: id, actor: by, targetId: actor.userId, details: { role: "owner" } },
        ctx,
      ),
    ],
  );
  if (!result.ok) return { ok: false, errors: [{ field: "slug", code: "slug_taken" }] };
  return { ok: true, workspace: summary({ workspace: result.workspace, role: "owner" }) };
}

/** The actor's workspaces, ordered by name. */
export async function listMyWorkspaces(
  ctx: ServiceContext,
  actor: UserActor,
): Promise<WorkspaceSummary[]> {
  return (await repo.listWorkspacesForUser(ctx.db, actor.userId)).map(summary);
}

/**
 * Resolves a workspace for the actor and authorizes the permission. A workspace the actor is not
 * a member of is indistinguishable from one that does not exist (NotFound), so slugs cannot be
 * discovered. A member without the permission, or any change to a suspended workspace, is
 * Forbidden.
 */
export async function openWorkspace(
  ctx: ServiceContext,
  actor: UserActor,
  slug: string,
  permission: WorkspacePermission,
): Promise<{ scope: WorkspaceScope; workspace: WorkspaceSummary }> {
  const parsed = parseWorkspaceSlug(slug);
  const found = parsed.ok
    ? await repo.findWorkspaceForMemberBySlug(ctx.db, { slug: parsed.value, userId: actor.userId })
    : null;
  if (found === null) throw new NotFoundError("workspace not found for actor");
  const changes = permission !== "workspace.read";
  if (changes && found.workspace.status !== "active") {
    throw new ForbiddenError("workspace is not active");
  }
  const scope = authorizeMembership(
    { workspaceId: found.workspace.id, userId: actor.userId, role: found.role },
    permission,
  );
  if (scope === null) throw new ForbiddenError(`role ${found.role} lacks ${permission}`);
  return { scope, workspace: summary(found) };
}

/** Renames a workspace the actor manages. An unchanged name is a no-op and writes nothing. */
export async function renameWorkspace(
  ctx: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly name: string },
): Promise<WorkspaceResult> {
  const { scope, workspace } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const name = parseWorkspaceName(input.name);
  if (!name.ok) return { ok: false, errors: [{ field: "name", code: name.error }] };
  if (name.value === workspace.name) return { ok: true, workspace };

  await repo.renameWorkspace(ctx.db, scope, { name: name.value, now: ctx.clock.now() }, [
    auditEvent(
      "workspace.renamed",
      {
        workspaceId: scope.workspaceId,
        actor: asAuditActor(actor),
        targetId: scope.workspaceId,
        details: { previousName: workspace.name, name: name.value },
      },
      ctx,
    ),
  ]);
  return { ok: true, workspace: { ...workspace, name: name.value } };
}

/**
 * Adds an existing user to a workspace the actor manages. There is no invitation flow yet; this
 * is the building block it will use.
 */
export async function addWorkspaceMember(
  ctx: ServiceContext,
  actor: UserActor,
  slug: string,
  member: { readonly userId: string; readonly role: WorkspaceRole },
): Promise<void> {
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const result = await repo.addWorkspaceMember(
    ctx.db,
    scope,
    { userId: member.userId, role: member.role, now: ctx.clock.now() },
    [
      auditEvent(
        "membership.added",
        {
          workspaceId: scope.workspaceId,
          actor: asAuditActor(actor),
          targetId: member.userId,
          details: { role: member.role },
        },
        ctx,
      ),
    ],
  );
  if (!result.ok) throw new ConflictError("user is already a member");
}
