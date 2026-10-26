import { viewWorkspaceAsOperator } from "@sharerepo/application";
import { Link, redirect } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { checkedText, formatInstant } from "../entitlement-messages.ts";
import { requireOperator } from "../operators.server.ts";
import { isCrossSiteRequest } from "../security/same-origin.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/ops.w.$slug";
import { AccessTableRow, FailuresSection, repositoriesOf } from "./w.$slug.access.tsx";

// An operator's read-only view of a workspace's Access page (decision 0014): the owner's scoped
// reads with every control disabled. Opening it is audited as `operator.viewed_workspace`.

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Workspace access · Operations · ShareRepo" },
    { name: "robots", content: "noindex" },
  ];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const operator = await requireOperator(request, context);
  // Opening the view writes `operator.viewed_workspace`: another site's link must not write it.
  if (isCrossSiteRequest(request)) throw redirect("/ops");
  const services = servicesFor(context);
  const view = await viewWorkspaceAsOperator(services, operator, params.slug).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return { ...view, now: services.clock.now() };
}

export default function OperatorWorkspaceAccess({ loaderData }: Route.ComponentProps) {
  const { workspace, access, failures, now } = loaderData;
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <Link to="/ops" className="text-sm underline">
        Back to operations
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{workspace.name}: access</h1>
      <p className="mt-2 text-gray-700">
        Read-only, as an operator. Workspace status: {workspace.status}. This visit is recorded in
        the workspace's audit history.
      </p>
      <FailuresSection failures={failures} />
      {access.rows.length === 0 ? (
        <p className="mt-6 text-gray-600">No subscribers have access.</p>
      ) : (
        <>
          <h2 className="mt-6 text-lg font-semibold">Repositories</h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {repositoriesOf(access.rows).map((repository) => (
              <li
                key={repository.id}
                aria-label={repository.name}
                className="flex flex-wrap gap-x-4"
              >
                <span className="font-medium">{repository.name}</span>
                <span className="text-gray-600">
                  {repository.lastReconciledAt === null
                    ? "Not checked yet"
                    : checkedText(repository.lastReconciledAt, now)}
                  {repository.nextReconcileAt !== null &&
                    ` · next check ${formatInstant(repository.nextReconcileAt)}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th className="py-2 pr-4 font-medium">Subscriber</th>
                  <th className="py-2 pr-4 font-medium">Repository</th>
                  <th className="py-2 pr-4 font-medium">Desired access</th>
                  <th className="py-2 pr-4 font-medium">Observed access</th>
                  <th className="py-2 font-medium">Planned action</th>
                </tr>
              </thead>
              <tbody>
                {access.rows.map((row) => (
                  <AccessTableRow
                    key={`${row.subjectId}:${row.resourceId}`}
                    row={row}
                    now={now}
                    canManage={false}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
