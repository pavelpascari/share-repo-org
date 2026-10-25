import {
  type AccessRow,
  listAccess,
  listOpenFailures,
  type ReconcileRequest,
  requestReconcileNow,
  retryFailure,
  retryGrant,
  type WorkspaceFailures,
} from "@sharerepo/application";
import { OutboxKind } from "@sharerepo/domain";
import { data, Form, Link, useNavigation } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { FailedJobsTable, FailingRepositoriesList } from "../components/failure-list.tsx";
import { cloudflareContext } from "../context.ts";
import {
  accessReasonText,
  checkedText,
  formatInstant,
  observedAccessText,
  plannedActionText,
} from "../entitlement-messages.ts";
import { attempt, simulatorEnabled } from "../entitlements.server.ts";
import { enqueueJob } from "../jobs.server.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.access";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Access · ShareRepo" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const services = servicesFor(context);
  const [{ rows, canManage }, failures] = await Promise.all([
    listAccess(services, user, params.slug),
    listOpenFailures(services, user, params.slug),
  ]).catch((error: unknown) => {
    throw asResponse(error);
  });
  return {
    rows,
    canManage,
    failures,
    // "Checked 5 min ago" is relative to this instant, so the server and browser render alike.
    now: services.clock.now(),
    slug: params.slug,
    simulatorEnabled: simulatorEnabled(context),
  };
}

type ActionData =
  | { ok: true; notice: string; error: null }
  | { ok: false; notice: null; error: string };

/**
 * "Check now" (`intent=check`, `resourceId`) and "Retry" (`intent=retry`, `grantId`), for owners:
 * the service queues the repository's reconciliation, and the row is handed to the queue at once.
 * "Retry" on a failed job (`intent=retry-job`, `outboxId`) makes one of the workspace's own failed
 * jobs due again (decision 0014), and hands it to the queue too.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const services = servicesFor(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "retry-job") {
    const outboxId = String(form.get("outboxId") ?? "");
    const retried = await attempt(() => retryFailure(services, user, params.slug, outboxId));
    if (!retried.ok) return { ok: false, notice: null, error: retried.error } satisfies ActionData;
    enqueueJob(context, retried.value);
    return { ok: true, notice: "Retry queued.", error: null } satisfies ActionData;
  }
  const run = (): Promise<ReconcileRequest> => {
    if (intent === "check") {
      return requestReconcileNow(services, user, params.slug, String(form.get("resourceId") ?? ""));
    }
    if (intent === "retry") {
      return retryGrant(services, user, params.slug, String(form.get("grantId") ?? ""));
    }
    throw data(null, { status: 400 });
  };
  const attempted = await attempt(run);
  if (!attempted.ok) {
    return { ok: false, notice: null, error: attempted.error } satisfies ActionData;
  }
  const { outboxId, subjectId } = attempted.value;
  if (outboxId !== null) {
    enqueueJob(context, { kind: OutboxKind.ReconcileResource, subjectId, outboxId });
  }
  return {
    ok: true,
    notice: intent === "check" ? "Check queued." : "Retry queued.",
    error: null,
  } satisfies ActionData;
}

/** The repositories in the rows, in first-seen order, with when each was and will be checked. */
export function repositoriesOf(rows: readonly AccessRow[]) {
  const repositories = new Map<
    string,
    { id: string; name: string; lastReconciledAt: number | null; nextReconcileAt: number | null }
  >();
  for (const row of rows) {
    if (repositories.has(row.resourceId)) continue;
    repositories.set(row.resourceId, {
      id: row.resourceId,
      name: row.resourceName,
      lastReconciledAt: row.resourceLastReconciledAt,
      nextReconcileAt: row.resourceNextReconcileAt,
    });
  }
  return [...repositories.values()];
}

export default function Access({ loaderData, actionData }: Route.ComponentProps) {
  const { rows, slug, canManage, now, failures } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">Access</h1>
      <p className="mt-2 text-gray-700">
        Who should have access to which repository, what GitHub shows, and what ShareRepo will do
        next.
      </p>
      <FailuresSection failures={failures} />
      {actionData?.ok && (
        <p role="status" className="mt-4 text-green-800">
          {actionData.notice}
        </p>
      )}
      {actionData?.ok === false && (
        <p role="alert" className="mt-4 text-red-700">
          {actionData.error}
        </p>
      )}
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
        <>
          <h2 className="mt-6 text-lg font-semibold">Repositories</h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {repositoriesOf(rows).map((repository) => (
              <li
                key={repository.id}
                aria-label={repository.name}
                className="flex flex-wrap items-center gap-x-4 gap-y-1"
              >
                <span className="font-medium">{repository.name}</span>
                <span className="text-gray-600">
                  {repository.lastReconciledAt === null
                    ? "Not checked yet"
                    : checkedText(repository.lastReconciledAt, now)}
                  {repository.nextReconcileAt !== null &&
                    ` · next check ${formatInstant(repository.nextReconcileAt)}`}
                </span>
                {canManage && (
                  <ControlForm intent="check" field="resourceId" value={repository.id}>
                    Check now
                  </ControlForm>
                )}
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
                {rows.map((row) => (
                  <AccessTableRow
                    key={`${row.subjectId}:${row.resourceId}`}
                    row={row}
                    now={now}
                    canManage={canManage}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Failures that need a person (decision 0014): failed jobs about this workspace's access, and
 * repositories whose checks keep failing. Owners can retry a failed job; dismissing one is for
 * ShareRepo support.
 */
export function FailuresSection({ failures }: { failures: WorkspaceFailures }) {
  if (failures.jobs.length === 0 && failures.repositories.length === 0) return null;
  return (
    <section aria-labelledby="needs-attention" className="mt-6 rounded border border-red-200 p-4">
      <h2 id="needs-attention" className="text-lg font-semibold">
        Needs attention
      </h2>
      {failures.jobs.length > 0 && (
        <>
          <p className="mt-2 text-sm text-gray-700">
            These jobs stopped retrying. Retry one once its cause is fixed, or contact support.
          </p>
          <div className="mt-2">
            <FailedJobsTable
              jobs={failures.jobs}
              {...(failures.canRetry
                ? {
                    actions: (job) => (
                      <ControlForm intent="retry-job" field="outboxId" value={job.id}>
                        Retry
                      </ControlForm>
                    ),
                  }
                : {})}
            />
          </div>
        </>
      )}
      {failures.repositories.length > 0 && (
        <>
          <h3 className="mt-4 font-medium">Repositories that keep failing to check</h3>
          <div className="mt-2">
            <FailingRepositoriesList repositories={failures.repositories} />
          </div>
        </>
      )}
    </section>
  );
}

/** A one-button POST form for an owner control. */
function ControlForm(props: {
  intent: "check" | "retry" | "retry-job";
  field: "resourceId" | "grantId" | "outboxId";
  value: string;
  children: string;
}) {
  const navigation = useNavigation();
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={props.intent} />
      <input type="hidden" name={props.field} value={props.value} />
      <button
        type="submit"
        disabled={navigation.state === "submitting"}
        className="rounded border border-gray-300 px-2 py-0.5 disabled:opacity-60"
      >
        {props.children}
      </button>
    </Form>
  );
}

export function AccessTableRow({
  row,
  now,
  canManage,
}: {
  row: AccessRow;
  now: number;
  canManage: boolean;
}) {
  const [current] = row.entitlements;
  const planned =
    row.planned === null
      ? null
      : plannedActionText(
          row.planned.action,
          row.planned.reason,
          row.grant?.nextAttemptAt ?? null,
          // The live entitlements come first; an expiry waits for their source.
          current?.source ?? null,
        );
  const observed = observedAccessText({ ...row, entitled: current?.state === "active" }, now);
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
        <div className="flex flex-col items-start">
          <span className="font-medium">{observed.label}</span>
          {observed.hint !== null && <span>{observed.hint}</span>}
          {observed.retry !== null && <span>{observed.retry}</span>}
          {observed.checked !== null && <span className="text-gray-600">{observed.checked}</span>}
          {canManage && row.grant?.state === "error" && (
            <div className="mt-1">
              <ControlForm intent="retry" field="grantId" value={row.grant.id}>
                Retry
              </ControlForm>
            </div>
          )}
        </div>
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
