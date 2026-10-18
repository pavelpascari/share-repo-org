import { openWorkspace, type WorkspaceSummary } from "@sharerepo/application";
import type { WorkspacePermission } from "@sharerepo/domain";
import { ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { createCookie, data, type RouterContextProvider } from "react-router";
import { servicesFor } from "./auth/server.ts";
import { requireUser, type SignedInUser } from "./auth/session.server.ts";
import { cloudflareContext } from "./context.ts";

type Context = Readonly<RouterContextProvider>;

/**
 * The signed-in user's workspace, authorized for the permission. Not a member (or no such slug)
 * is a 404 and a member without the permission is a 403, both rendered by the error boundary.
 */
export async function loadWorkspace(
  request: Request,
  context: Context,
  slug: string,
  permission: WorkspacePermission,
): Promise<{ user: SignedInUser; workspace: WorkspaceSummary }> {
  const user = await requireUser(request, context);
  try {
    const { workspace } = await openWorkspace(servicesFor(context), user, slug, permission);
    return { user, workspace };
  } catch (error) {
    throw asResponse(error);
  }
}

/** Maps expected service errors to error responses; anything else stays a 500. */
export function asResponse(error: unknown): unknown {
  if (error instanceof NotFoundError) return data(null, { status: 404 });
  if (error instanceof ForbiddenError) return data(null, { status: 403 });
  return error;
}

/**
 * Remembers the last workspace opened, so `/` can return to it after sign-in. It only selects a
 * redirect target; every request is still authorized from the session.
 */
export function lastWorkspaceCookie(context: Context) {
  const secure = context.get(cloudflareContext).env.auth.baseURL.startsWith("https:");
  return createCookie("sharerepo_last_workspace", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
