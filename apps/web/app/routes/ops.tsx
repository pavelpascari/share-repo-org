import {
  dismissFailure,
  type FailedJob,
  listAllOpenFailures,
  operatorSessionIsFresh,
  retryFailureAsOperator,
} from "@sharerepo/application";
import { NotFoundError } from "@sharerepo/platform";
import { Form, Link, useNavigation } from "react-router";
import { z } from "zod";
import { servicesFor } from "../auth/server.ts";
import {
  FailedJobsTable,
  FailingRepositoriesList,
  PurgeBlockedList,
} from "../components/failure-list.tsx";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { formatInstant } from "../entitlement-messages.ts";
import { CONNECTION_STATUS_TEXTS, DISMISS_ERRORS } from "../failure-messages.ts";
import { enqueueJob } from "../jobs.server.ts";
import { requireOperator, requireOperatorSession } from "../operators.server.ts";
import { assertSameOrigin, isCrossSiteRequest } from "../security/same-origin.ts";
import type { Route } from "./+types/ops";

// `/ops` (decision 0014): every workspace's open failures, repositories that keep failing,
// unhealthy connections and sweep health, for operators only. Everyone else gets a 404.

export function meta(_: Route.MetaArgs) {
  return [{ title: "Operations · ShareRepo" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const operator = await requireOperator(request, context);
  // Reading the lists writes `operator.viewed_failures`: a navigation another site started must
  // not write it, so it gets a page with only a link to continue (which is same-origin).
  if (isCrossSiteRequest(request)) return { lists: null };
  const services = servicesFor(context);
  const failures = await listAllOpenFailures(services, operator);
  return { lists: { ...failures, now: services.clock.now() } };
}

const id = z.string().min(1).max(128);
/** The failure's workspace; empty for a system-wide failure. */
const workspaceId = z
  .string()
  .max(128)
  .transform((value) => (value === "" ? null : value));

/** The `/ops` forms, validated before anything is read (Zod at the boundary). */
const opsForm = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("retry"), outboxId: id, workspaceId }),
  z.object({
    intent: z.literal("dismiss"),
    outboxId: id,
    workspaceId,
    reason: z.string().max(2000),
  }),
]);

type ActionData =
  | { ok: true; notice: string; error: null; outboxId: string; reauthenticate?: never }
  | {
      ok: false;
      notice: null;
      error: string;
      outboxId: string | null;
      /** The session is too old for a retry or dismissal: sign in again first. */
      reauthenticate?: true;
    };

const GONE = "That failure is no longer open. Reload to see the current list.";
const STALE_SESSION =
  "For your security, sign in again with GitHub before you retry or dismiss a failure. Your session is more than two hours old.";

/**
 * Retry (`intent=retry`) or dismiss (`intent=dismiss`, with a `reason`) one failure, named by its
 * workspace and outbox ID together (threat O3). Both are audited with the operator as actor, and
 * both need a session created within `OPERATOR_SESSION_MAX_AGE_MS`: an older one is asked to
 * sign in again through GitHub, and nothing changes.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { operator, sessionCreatedAt } = await requireOperatorSession(request, context);
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const parsed = opsForm.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return {
      ok: false,
      notice: null,
      error: "The form could not be read. Reload and try again.",
      outboxId: null,
    } satisfies ActionData;
  }
  const form = parsed.data;
  const services = servicesFor(context);
  if (!operatorSessionIsFresh(sessionCreatedAt, services.clock.now())) {
    return {
      ok: false,
      notice: null,
      error: STALE_SESSION,
      outboxId: form.outboxId,
      reauthenticate: true,
    } satisfies ActionData;
  }
  try {
    if (form.intent === "retry") {
      const retried = await retryFailureAsOperator(services, operator, form);
      enqueueJob(context, retried);
      return {
        ok: true,
        notice: "Retry queued.",
        error: null,
        outboxId: form.outboxId,
      } satisfies ActionData;
    }
    const dismissed = await dismissFailure(services, operator, form);
    return dismissed.ok
      ? ({
          ok: true,
          notice: "Dismissed.",
          error: null,
          outboxId: form.outboxId,
        } satisfies ActionData)
      : ({
          ok: false,
          notice: null,
          error: DISMISS_ERRORS[dismissed.error],
          outboxId: form.outboxId,
        } satisfies ActionData);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return { ok: false, notice: null, error: GONE, outboxId: form.outboxId } satisfies ActionData;
  }
}

/** How late a due row is, or that nothing is due. */
function lateness(at: number | null, now: number): string {
  if (at === null) return "Nothing due";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return `${formatInstant(at)} (${minutes} min ago)`;
}

export default function Ops({ loaderData, actionData }: Route.ComponentProps) {
  const { lists } = loaderData;
  if (lists === null) {
    // Another site sent the browser here: nothing was read or recorded yet.
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">Operations</h1>
        <p className="mt-2 text-gray-700">
          You followed a link from another site. Opening the operations lists is recorded in the
          audit history.
        </p>
        <Link to="/ops" className="mt-4 inline-block underline">
          Continue to operations
        </Link>
      </main>
    );
  }
  const { jobs, repositories, connections, purgesBlocked, sweep, now } = lists;
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Operations</h1>
        <Link to="/" className="text-sm underline">
          ShareRepo
        </Link>
      </header>
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
      {actionData?.reauthenticate && (
        <Form method="post" action="/sign-in" className="mt-2">
          <input type="hidden" name="returnTo" value="/ops" />
          <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-white">
            Sign in again with GitHub
          </button>
        </Form>
      )}

      <section aria-labelledby="sweep-health" className="mt-6">
        <h2 id="sweep-health" className="text-lg font-semibold">
          Sweep health
        </h2>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="font-medium">Last heartbeat</dt>
          <dd>
            {sweep.lastHeartbeatAt === null ? "Unknown" : lateness(sweep.lastHeartbeatAt, now)}
          </dd>
          <dt className="font-medium">Oldest due subscription check</dt>
          <dd>{lateness(sweep.oldestDueEvaluationAt, now)}</dd>
          <dt className="font-medium">Oldest due repository check</dt>
          <dd>{lateness(sweep.oldestDueReconcileAt, now)}</dd>
          <dt className="font-medium">Oldest due job</dt>
          <dd>{lateness(sweep.oldestDueOutboxAt, now)}</dd>
        </dl>
      </section>

      <section aria-labelledby="failed-jobs" className="mt-8">
        <h2 id="failed-jobs" className="text-lg font-semibold">
          Failed jobs
        </h2>
        {jobs.length === 0 ? (
          <p className="mt-2 text-gray-600">No open failures.</p>
        ) : (
          <div className="mt-2">
            <FailedJobsTable
              jobs={jobs}
              showWorkspace
              actions={(job) => (
                <FailureActions
                  job={job}
                  error={
                    actionData?.outboxId === job.id && actionData.ok === false
                      ? actionData.error
                      : undefined
                  }
                />
              )}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="failing-repositories" className="mt-8">
        <h2 id="failing-repositories" className="text-lg font-semibold">
          Repositories that keep failing to check
        </h2>
        {repositories.length === 0 ? (
          <p className="mt-2 text-gray-600">None.</p>
        ) : (
          <div className="mt-2">
            <FailingRepositoriesList repositories={repositories} showWorkspace />
          </div>
        )}
      </section>

      <section aria-labelledby="unhealthy-connections" className="mt-8">
        <h2 id="unhealthy-connections" className="text-lg font-semibold">
          Connections that stopped working
        </h2>
        {connections.length === 0 ? (
          <p className="mt-2 text-gray-600">None.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {connections.map((connection) => (
              <li
                key={`${connection.provider}:${connection.connectionId}`}
                className="flex flex-col"
              >
                <span className="font-medium">
                  {connection.provider === "github" ? "GitHub" : "Paddle"} · {connection.name}
                </span>
                <span>
                  {CONNECTION_STATUS_TEXTS[connection.status] ?? connection.status} since{" "}
                  {formatInstant(connection.since)} ·{" "}
                  <Link to={`/ops/w/${connection.workspaceSlug}`} className="underline">
                    {connection.workspaceName}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="purges-blocked" className="mt-8">
        <h2 id="purges-blocked" className="text-lg font-semibold">
          Workspace deletions that wait
        </h2>
        {purgesBlocked.length === 0 ? (
          <p className="mt-2 text-gray-600">None.</p>
        ) : (
          <div className="mt-2">
            <PurgeBlockedList blocks={purgesBlocked} showWorkspace />
          </div>
        )}
      </section>
    </main>
  );
}

/** Retry, dismiss with a reason, and a link to the workspace's read-only Access page. */
function FailureActions({ job, error }: { job: FailedJob; error: string | undefined }) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <div className="flex flex-col gap-2">
      {job.workspaceSlug !== null && (
        <Link to={`/ops/w/${job.workspaceSlug}`} className="underline">
          View access
        </Link>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="retry" />
        <input type="hidden" name="outboxId" value={job.id} />
        <input type="hidden" name="workspaceId" value={job.workspaceId ?? ""} />
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-gray-300 px-2 py-0.5 disabled:opacity-60"
        >
          Retry
        </button>
      </Form>
      <Form method="post" className="flex flex-col gap-1">
        <input type="hidden" name="intent" value="dismiss" />
        <input type="hidden" name="outboxId" value={job.id} />
        <input type="hidden" name="workspaceId" value={job.workspaceId ?? ""} />
        <TextField name="reason" label="Reason" isRequired error={error} />
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded border border-gray-300 px-2 py-0.5 disabled:opacity-60"
        >
          Dismiss
        </button>
      </Form>
    </div>
  );
}
