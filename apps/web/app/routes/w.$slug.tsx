import { data, Link, Outlet } from "react-router";
import { simulatorEnabled } from "../entitlements.server.ts";
import { lastWorkspaceCookie, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { workspace } = await loadWorkspace(request, context, params.slug, "workspace.read");
  return data(
    { workspace, simulatorEnabled: simulatorEnabled(context) },
    { headers: { "set-cookie": await lastWorkspaceCookie(context).serialize(workspace.slug) } },
  );
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.workspace.name ?? "Workspace"} · ShareRepo` }];
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { workspace, simulatorEnabled } = loaderData;
  return (
    <>
      <nav className="mb-6 flex flex-wrap gap-4 text-sm">
        <Link to={`/w/${workspace.slug}`} className="underline">
          Overview
        </Link>
        <Link to={`/w/${workspace.slug}/repositories`} className="underline">
          Repositories
        </Link>
        <Link to={`/w/${workspace.slug}/offers`} className="underline">
          Offers
        </Link>
        <Link to={`/w/${workspace.slug}/access`} className="underline">
          Access
        </Link>
        {simulatorEnabled && (
          <Link to={`/w/${workspace.slug}/simulator`} className="underline">
            Simulator
          </Link>
        )}
        {workspace.role === "owner" && (
          <>
            <Link to={`/w/${workspace.slug}/customers`} className="underline">
              Customers
            </Link>
            <Link to={`/w/${workspace.slug}/billing`} className="underline">
              Billing
            </Link>
            <Link to={`/w/${workspace.slug}/settings`} className="underline">
              Settings
            </Link>
          </>
        )}
      </nav>
      {(workspace.status === "deleting" || workspace.status === "purging") && (
        <p className="mb-6 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          This workspace is being deleted and is read-only.
          {workspace.role === "owner" && workspace.status === "deleting" && (
            <>
              {" "}
              <Link to={`/w/${workspace.slug}/settings`} className="underline">
                See settings
              </Link>{" "}
              to cancel.
            </>
          )}
        </p>
      )}
      <Outlet />
    </>
  );
}
