import {
  grantManualAccess,
  listManualAccess,
  type ManualAccessSummary,
  revokeManualAccess,
  updateManualAccessEnd,
} from "@sharerepo/application";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { Form, useNavigation } from "react-router";
import { z } from "zod";
import { servicesFor } from "../auth/server.ts";
import { enqueueReconcilesSince, githubAppFor } from "../commerce.server.ts";
import {
  MANUAL_ACCESS_ERRORS,
  MANUAL_ACCESS_STATUS_LABELS,
  MANUAL_ACCESS_UPDATE_ERRORS,
} from "../commerce-messages.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { formatDate, formatInstant } from "../entitlement-messages.ts";
import { attempt } from "../entitlements.server.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.manual-access";

// Manual access (decision 0016): an owner grants an offer's repositories to a GitHub account by
// hand, without a purchase, for early buyers and trials, and can change the end date or revoke.

export function meta(_: Route.MetaArgs) {
  return [{ title: "Manual access · ShareRepo" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.manage");
  const view = await listManualAccess(servicesFor(context), user, params.slug).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return view;
}

/** A `YYYY-MM-DD` end date as its UTC midnight; empty for no end. Undefined when malformed. */
function parseEndDate(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return undefined;
  const instant = Date.parse(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(instant) ? undefined : instant;
}

const grantForm = z.object({
  offerId: z.string().min(1).max(128),
  githubLogin: z.string().max(100),
  endsOn: z.string().max(20),
  note: z.string().max(2000),
});
const changeForm = z.object({
  manualAccessId: z.string().min(1).max(128),
  endsOn: z.string().max(20),
});

type ActionData =
  | { target: string; notice: string; error: null }
  | { target: string; notice: null; error: string };

const BAD_DATE = "Enter the end date as a date, or leave it empty for no end.";

/** Owner only: grant, change the end date of, or revoke manual access. Same-origin POSTs. */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const { user, workspace } = await loadWorkspace(
    request,
    context,
    params.slug,
    "workspace.manage",
  );
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const services = servicesFor(context);
  const since = services.clock.now();
  const fail = (target: string, error: string): ActionData => ({ target, notice: null, error });
  const done = (target: string, notice: string): ActionData => {
    // The change requested reconciliations of the offer's repositories; run them now.
    enqueueReconcilesSince(context, workspace.id, since);
    return { target, notice, error: null };
  };

  if (intent === "grant") {
    const parsed = grantForm.safeParse({
      offerId: form.get("offerId") ?? "",
      githubLogin: form.get("githubLogin") ?? "",
      endsOn: form.get("endsOn") ?? "",
      note: form.get("note") ?? "",
    });
    if (!parsed.success) return fail("new", "Choose an offer and enter a GitHub login.");
    const endsAt = parseEndDate(parsed.data.endsOn);
    if (endsAt === undefined) return fail("new", BAD_DATE);
    const github = githubAppFor(context);
    if (github === null) return fail("new", MANUAL_ACCESS_ERRORS.connection_missing);
    const attempted = await attempt(() =>
      grantManualAccess(services, user, params.slug, { ...parsed.data, endsAt }, { github }),
    );
    if (!attempted.ok) return fail("new", attempted.error);
    const result = attempted.value;
    if (!result.ok) return fail("new", MANUAL_ACCESS_ERRORS[result.error]);
    return done("new", `Granted access to @${result.login}. ShareRepo is inviting them on GitHub.`);
  }

  const parsed = changeForm.safeParse({
    manualAccessId: form.get("manualAccessId") ?? "",
    endsOn: form.get("endsOn") ?? "",
  });
  if (!parsed.success) return fail("", "Choose a grant to change.");
  const { manualAccessId } = parsed.data;
  if (intent === "revoke") {
    const attempted = await attempt(() =>
      revokeManualAccess(services, user, params.slug, { manualAccessId }),
    );
    if (!attempted.ok) return fail(manualAccessId, attempted.error);
    return done(
      manualAccessId,
      attempted.value.outcome === "revoked"
        ? "Access revoked. ShareRepo is removing it on GitHub."
        : "This access was already revoked.",
    );
  }
  if (intent === "update") {
    const endsAt = parseEndDate(parsed.data.endsOn);
    if (endsAt === undefined) return fail(manualAccessId, BAD_DATE);
    const attempted = await attempt(() =>
      updateManualAccessEnd(services, user, params.slug, { manualAccessId, endsAt }),
    );
    if (!attempted.ok) return fail(manualAccessId, attempted.error);
    const result = attempted.value;
    if (!result.ok) return fail(manualAccessId, MANUAL_ACCESS_UPDATE_ERRORS[result.error]);
    return done(
      manualAccessId,
      result.outcome === "updated" ? "End date saved." : "The end date is unchanged.",
    );
  }
  return fail("", "Unknown action.");
}

export default function ManualAccess({ loaderData, actionData }: Route.ComponentProps) {
  const { offers, accesses } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <>
      <h1 className="text-2xl font-semibold">Manual access</h1>
      <p className="mt-2 text-gray-700">
        Give someone an offer's repositories without a purchase: an early buyer, a trial, or a
        collaborator. ShareRepo invites the GitHub account and removes it when you revoke the access
        or its end date passes. Each grant is recorded in the workspace history.
      </p>

      <Form method="post" className="mt-6 flex flex-col gap-4 rounded border border-gray-200 p-4">
        <h2 className="text-lg font-semibold">Grant access</h2>
        {actionData?.target === "new" && actionData.notice !== null && (
          <p role="status" className="text-green-800">
            {actionData.notice}
          </p>
        )}
        {actionData?.target === "new" && actionData.error !== null && (
          <p role="alert" className="text-red-700">
            {actionData.error}
          </p>
        )}
        <input type="hidden" name="intent" value="grant" />
        {offers.length === 0 ? (
          <p className="text-gray-600">Create an offer with at least one repository first.</p>
        ) : (
          <RadioGroup
            name="offerId"
            defaultValue={offers[0]?.id ?? ""}
            isRequired
            className="flex flex-col gap-1"
          >
            <Label className="text-sm font-medium">Offer</Label>
            {offers.map((offer) => (
              <Radio
                key={offer.id}
                value={offer.id}
                className="group flex items-center gap-2 data-[focus-visible]:underline"
              >
                <span
                  aria-hidden="true"
                  className="h-3 w-3 rounded-full border border-gray-500 group-data-[selected]:bg-gray-900"
                />
                {offer.name}
              </Radio>
            ))}
          </RadioGroup>
        )}
        <TextField
          name="githubLogin"
          label="GitHub login"
          isRequired
          description="A personal GitHub account. They don't need a ShareRepo account."
          className="max-w-xs"
        />
        <TextField
          name="endsOn"
          label="End date (optional)"
          type="date"
          description="Access ends at 00:00 UTC on this date. Leave empty for no end."
          className="max-w-xs"
        />
        <TextField
          name="note"
          label="Note (optional)"
          description="Why you granted it, for your records. Don't enter email addresses."
        />
        <button
          type="submit"
          disabled={busy || offers.length === 0}
          className="self-start rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
        >
          Grant access
        </button>
      </Form>

      <h2 className="mt-8 text-lg font-semibold">Grants</h2>
      {accesses.length === 0 ? (
        <p className="mt-2 text-gray-600">No manual access granted yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-4">
          {accesses.map((access) => (
            <GrantCard
              key={access.id}
              access={access}
              busy={busy}
              result={actionData?.target === access.id ? actionData : null}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function GrantCard(props: {
  access: ManualAccessSummary;
  busy: boolean;
  result: { notice: string | null; error: string | null } | null;
}) {
  const { access, busy, result } = props;
  return (
    <li className="rounded border border-gray-200 p-4" aria-label={access.login}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">@{access.login}</h3>
        <span className="text-sm font-medium">{MANUAL_ACCESS_STATUS_LABELS[access.status]}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-600">Offer</dt>
        <dd>{access.offerName}</dd>
        <dt className="text-gray-600">Granted</dt>
        <dd>{formatInstant(access.grantedAt)}</dd>
        <dt className="text-gray-600">Ends</dt>
        <dd>{access.endsAt === null ? "No end date" : formatInstant(access.endsAt)}</dd>
        {access.revokedAt !== null && (
          <>
            <dt className="text-gray-600">Revoked</dt>
            <dd>
              {formatInstant(access.revokedAt)}
              {access.revokeCause === "account_deleted" &&
                " (the account holder deleted their ShareRepo account)"}
            </dd>
          </>
        )}
        {access.note !== null && (
          <>
            <dt className="text-gray-600">Note</dt>
            <dd>{access.note}</dd>
          </>
        )}
      </dl>
      {result?.notice != null && (
        <p role="status" className="mt-3 text-green-800">
          {result.notice}
        </p>
      )}
      {result?.error != null && (
        <p role="alert" className="mt-3 text-red-700">
          {result.error}
        </p>
      )}
      {access.status !== "revoked" && (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="manualAccessId" value={access.id} />
            <TextField
              name="endsOn"
              label="New end date"
              type="date"
              defaultValue={access.endsAt === null ? "" : formatDate(access.endsAt)}
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded border border-gray-400 px-3 py-2 text-sm disabled:opacity-60"
            >
              Save end date
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="revoke" />
            <input type="hidden" name="manualAccessId" value={access.id} />
            <button
              type="submit"
              disabled={busy}
              className="rounded border border-red-600 px-3 py-2 text-sm text-red-700 disabled:opacity-60"
            >
              Revoke
            </button>
          </Form>
        </div>
      )}
    </li>
  );
}
