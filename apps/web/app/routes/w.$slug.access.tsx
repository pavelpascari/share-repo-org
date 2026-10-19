import { type AccessRow, listAccess } from "@sharerepo/application";
import { Link } from "react-router";
import { servicesFor } from "../auth/server.ts";
import {
  accessReasonText,
  formatInstant,
  GRANT_STATE_LABELS,
  plannedActionText,
} from "../entitlement-messages.ts";
import { simulatorEnabled } from "../entitlements.server.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.access";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Access · ShareRepo" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const { rows } = await listAccess(servicesFor(context), user, params.slug).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return { rows, slug: params.slug, simulatorEnabled: simulatorEnabled(context) };
}

export default function Access({ loaderData }: Route.ComponentProps) {
  const { rows, slug } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">Access</h1>
      <p className="mt-2 text-gray-700">
        Who should have access to which repository, what GitHub shows, and what ShareRepo will do
        next.
      </p>
      {rows.length === 0 ? (
        <div className="mt-6 text-gray-600">
          <p>No subscribers have access yet.</p>
          <p className="mt-2">
            Create an offer on the{" "}
            <Link to={`/w/${slug}/offers`} className="underline">
              Offers
            </Link>{" "}
            page
            {loaderData.simulatorEnabled ? (
              <>
                , then add a test subscriber in the{" "}
                <Link to={`/w/${slug}/simulator`} className="underline">
                  Simulator
                </Link>
                .
              </>
            ) : (
              "."
            )}
          </p>
        </div>
      ) : (
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
              {rows.map((row) => (
                <AccessTableRow key={`${row.subjectId}:${row.resourceId}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AccessTableRow({ row }: { row: AccessRow }) {
  const [current] = row.entitlements;
  const planned =
    row.planned === null ? null : plannedActionText(row.planned.action, row.planned.reason);
  return (
    <tr className="border-b border-gray-200 align-top">
      <td className="py-2 pr-4">{row.subjectLogin}</td>
      <td className="py-2 pr-4">{row.resourceName}</td>
      <td className="py-2 pr-4">
        {current === undefined ? (
          "None"
        ) : (
          <div className="flex flex-col">
            <span className="font-medium">{current.state === "active" ? "Active" : "Ended"}</span>
            <span>
              {current.state !== "active" && current.endedAt !== null
                ? `Ended ${formatInstant(current.endedAt)}`
                : current.validUntil === null
                  ? "No end date"
                  : `Until ${formatInstant(current.validUntil)}`}
            </span>
            <span>{accessReasonText(current.reason)}</span>
            <span className="text-gray-600">
              {current.offerName}, version {current.offerVersion} · policy version{" "}
              {current.policyVersion}
            </span>
          </div>
        )}
      </td>
      <td className="py-2 pr-4">
        {row.grant === null
          ? "Not checked yet"
          : `${GRANT_STATE_LABELS[row.grant.state]}${row.grant.managed ? "" : " (not granted by ShareRepo)"}`}
      </td>
      <td className="py-2">
        {planned === null ? (
          "Nothing to do"
        ) : (
          <div className="flex flex-col">
            <span className="font-medium">{planned.label}</span>
            <span className="text-gray-600">{planned.detail}</span>
          </div>
        )}
      </td>
    </tr>
  );
}
