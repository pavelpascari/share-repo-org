import { data, Link, Outlet } from "react-router";
import { lastWorkspaceCookie, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { workspace } = await loadWorkspace(request, context, params.slug, "workspace.read");
  return data(
    { workspace },
    { headers: { "set-cookie": await lastWorkspaceCookie(context).serialize(workspace.slug) } },
  );
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.workspace.name ?? "Workspace"} · ShareRepo` }];
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  return (
    <>
      <nav className="mb-6 flex gap-4 text-sm">
        <Link to={`/w/${workspace.slug}`} className="underline">
          Overview
        </Link>
        <Link to={`/w/${workspace.slug}/repositories`} className="underline">
          Repositories
        </Link>
        {workspace.role === "owner" && (
          <Link to={`/w/${workspace.slug}/settings`} className="underline">
            Settings
          </Link>
        )}
      </nav>
      <Outlet />
    </>
  );
}
