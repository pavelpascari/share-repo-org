import {
  applySimulationAction,
  createSimulatedSubscriber,
  encodeRefreshKey,
  listSimulatedSubscriptions,
  SIMULATION_ACTIONS,
  type SimulatedSubscriptionSummary,
  type SimulationAction,
  type SimulationResult,
  simulateSubscriptionAction,
} from "@sharerepo/application";
import { roleAllows } from "@sharerepo/domain";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { data, Form, useNavigation } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import {
  formatInstant,
  parseItemIds,
  SIMULATION_ACTION_LABELS,
  SIMULATION_ERRORS,
  SUBSCRIPTION_STATE_LABELS,
} from "../entitlement-messages.ts";
import { attempt, simulationOption } from "../entitlements.server.ts";
import { githubFor } from "../github.server.ts";
import { enqueueJob } from "../jobs.server.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.simulator";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Simulator · ShareRepo" }];
}

const DEFAULT_PERIOD_DAYS = 30;

/** The lifecycle actions that apply to a subscription now, in lifecycle order. */
function availableActions(row: SimulatedSubscriptionSummary, now: number): SimulationAction[] {
  return SIMULATION_ACTIONS.filter((action) => applySimulationAction(row, action, now).ok);
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  // The service refuses with NotFound when the simulator is disabled, so production 404s.
  const simulation = simulationOption(context);
  const { user, workspace } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const subscriptions = await listSimulatedSubscriptions(servicesFor(context), user, params.slug, {
    simulation,
  }).catch((error: unknown) => {
    throw asResponse(error);
  });
  const now = Date.now();
  return {
    canManage: roleAllows(workspace.role, "workspace.manage"),
    subscriptions: subscriptions.map((subscription) => ({
      ...subscription,
      actions: availableActions(subscription, now),
    })),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const simulation = simulationOption(context);
  // The services refuse too; this keeps "GitHub not configured" from answering first.
  if (!simulation.enabled) throw data(null, { status: 404 });
  const { user, workspace } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const services = servicesFor(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const run = async (): Promise<SimulationResult> => {
    if (intent === "create") {
      const github = githubFor(context);
      // Without the GitHub App there is no connection to look the login up with.
      if (github === null) return { ok: false, error: "connection_missing" };
      const period = String(form.get("periodDays") ?? "").trim();
      return createSimulatedSubscriber(
        services,
        user,
        params.slug,
        {
          login: String(form.get("login") ?? "").trim(),
          items: parseItemIds(String(form.get("items") ?? "")),
          state: form.get("state") === "trialing" ? "trialing" : "active",
          periodDays: period === "" ? Number.NaN : Number(period),
        },
        { github, simulation },
      );
    }
    return simulateSubscriptionAction(
      services,
      user,
      params.slug,
      String(form.get("id") ?? ""),
      String(form.get("action") ?? ""),
      { simulation },
    );
  };
  const attempted = await attempt(run);
  const target = intent === "create" ? "new" : String(form.get("id") ?? "");
  if (!attempted.ok) return { target, error: attempted.error, notice: null };
  const result = attempted.value;
  if (!result.ok) return { target, error: SIMULATION_ERRORS[result.error], notice: null };
  enqueueJob(context, {
    kind: "refresh_subscription",
    subjectId: encodeRefreshKey({
      workspaceId: workspace.id,
      source: "simulated",
      externalSubscriptionId: result.subscription.id,
    }),
    outboxId: result.outboxId,
  });
  const { customerLogin, state } = result.subscription;
  return {
    target,
    error: null,
    notice:
      intent === "create"
        ? `Added ${customerLogin} as a simulated subscriber.`
        : `${customerLogin}'s subscription is now ${SUBSCRIPTION_STATE_LABELS[state].toLowerCase()}.`,
  };
}

export default function Simulator({ loaderData, actionData }: Route.ComponentProps) {
  const { canManage, subscriptions } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <>
      <h1 className="text-2xl font-semibold">Simulator</h1>
      <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
        Simulated billing for testing. Nobody is charged: these subscriptions stand in for a payment
        provider so you can try offers and access before going live. The simulator is not available
        in production.
      </p>
      {actionData?.notice && (
        <p role="status" className="mt-4 text-green-800">
          {actionData.notice}
        </p>
      )}
      {actionData?.error && actionData.target !== "new" && (
        <p role="alert" className="mt-4 text-red-700">
          {actionData.error}
        </p>
      )}

      <h2 className="mt-8 text-lg font-semibold">Simulated subscriptions</h2>
      {subscriptions.length === 0 ? (
        <p className="mt-2 text-gray-600">No simulated subscribers yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-4">
          {subscriptions.map((subscription) => (
            <li
              key={subscription.id}
              aria-label={subscription.customerLogin}
              className="rounded border border-gray-200 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{subscription.customerLogin}</h3>
                <span className="text-sm font-medium">
                  {SUBSCRIPTION_STATE_LABELS[subscription.state]}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-gray-600">Items</dt>
                <dd>{subscription.items.join(", ")}</dd>
                <dt className="text-gray-600">Current period</dt>
                <dd>
                  {formatInstant(subscription.currentPeriodStart)} to{" "}
                  {formatInstant(subscription.currentPeriodEnd)}
                </dd>
                {subscription.cancelAt !== null && (
                  <>
                    <dt className="text-gray-600">Cancels at</dt>
                    <dd>{formatInstant(subscription.cancelAt)}</dd>
                  </>
                )}
                {subscription.pastDueSince !== null && (
                  <>
                    <dt className="text-gray-600">Past due since</dt>
                    <dd>{formatInstant(subscription.pastDueSince)}</dd>
                  </>
                )}
                {subscription.endedAt !== null && (
                  <>
                    <dt className="text-gray-600">Ended</dt>
                    <dd>{formatInstant(subscription.endedAt)}</dd>
                  </>
                )}
              </dl>
              {canManage && subscription.actions.length > 0 && (
                <Form method="post" className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="intent" value="action" />
                  <input type="hidden" name="id" value={subscription.id} />
                  {subscription.actions.map((action) => (
                    <button
                      key={action}
                      type="submit"
                      name="action"
                      value={action}
                      disabled={busy}
                      className="rounded border border-gray-400 px-3 py-1 text-sm disabled:opacity-60"
                    >
                      {SIMULATION_ACTION_LABELS[action]}
                    </button>
                  ))}
                </Form>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <Form method="post" className="mt-10 flex flex-col gap-4 border-t border-gray-200 pt-6">
          <h2 className="text-lg font-semibold">Add a simulated subscriber</h2>
          {actionData?.error && actionData.target === "new" && (
            <p role="alert" className="text-red-700">
              {actionData.error}
            </p>
          )}
          <input type="hidden" name="intent" value="create" />
          <TextField
            name="login"
            label="GitHub login"
            isRequired
            description="The subscriber's personal GitHub account."
          />
          <TextField
            name="items"
            label="Commercial item IDs"
            isRequired
            description="Comma-separated, matching an offer's items, for example sim_monthly."
          />
          <RadioGroup name="state" defaultValue="active" className="flex flex-col gap-1">
            <Label className="text-sm font-medium">Start as</Label>
            <div className="flex gap-4">
              {(["trialing", "active"] as const).map((state) => (
                <Radio
                  key={state}
                  value={state}
                  className="group flex items-center gap-2 data-[focus-visible]:underline"
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full border border-gray-500 group-data-[selected]:bg-gray-900"
                  />
                  {state === "trialing" ? "Trial" : "Active"}
                </Radio>
              ))}
            </div>
          </RadioGroup>
          <TextField
            name="periodDays"
            label="Period length (days)"
            type="number"
            min={1}
            max={366}
            isRequired
            defaultValue={String(DEFAULT_PERIOD_DAYS)}
            className="max-w-xs"
          />
          <button
            type="submit"
            disabled={busy}
            className="self-start rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
          >
            Add subscriber
          </button>
        </Form>
      )}
    </>
  );
}
