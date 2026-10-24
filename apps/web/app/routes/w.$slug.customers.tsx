import { type CustomerSummary, linkCustomerManually, listCustomers } from "@sharerepo/application";
import { Form, useNavigation } from "react-router";
import { z } from "zod";
import { servicesFor } from "../auth/server.ts";
import { githubAppFor } from "../commerce.server.ts";
import { MANUAL_LINK_ERRORS } from "../commerce-messages.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { formatDate, SUBSCRIPTION_STATE_LABELS } from "../entitlement-messages.ts";
import { attempt } from "../entitlements.server.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.customers";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Customers · ShareRepo" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.manage");
  const customers = await listCustomers(servicesFor(context), user, params.slug).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return { customers };
}

const linkForm = z.object({
  customerId: z.string().min(1).max(128),
  githubLogin: z.string().max(100),
  reason: z.string().max(2000),
});

type ActionData =
  | { ok: true; notice: string; customerId: string; error: null }
  | { ok: false; notice: null; customerId: string; error: string };

/** Owner only: links a customer to a GitHub account by hand, with a reason (decision 0012). */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.manage");
  const form = await request.formData();
  const parsed = linkForm.safeParse({
    customerId: form.get("customerId") ?? "",
    githubLogin: form.get("githubLogin") ?? "",
    reason: form.get("reason") ?? "",
  });
  const customerId = parsed.success ? parsed.data.customerId : "";
  const fail = (error: string): ActionData => ({ ok: false, notice: null, customerId, error });
  if (!parsed.success) return fail("Enter a GitHub login and a reason.");
  const github = githubAppFor(context);
  if (github === null) return fail(MANUAL_LINK_ERRORS.connection_missing);
  const attempted = await attempt(() =>
    linkCustomerManually(servicesFor(context), user, params.slug, parsed.data, { github }),
  );
  if (!attempted.ok) return fail(attempted.error);
  const result = attempted.value;
  if (!result.ok) return fail(MANUAL_LINK_ERRORS[result.error]);
  const login = parsed.data.githubLogin.trim();
  return {
    ok: true,
    notice:
      result.outcome === "already_linked"
        ? `This customer is already linked to @${login}.`
        : `Linked the customer to @${login}. Their access follows shortly.`,
    customerId,
    error: null,
  } satisfies ActionData;
}

export default function Customers({ loaderData, actionData }: Route.ComponentProps) {
  const { customers } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">Customers</h1>
      <p className="mt-2 text-gray-700">
        People who bought a subscription, and the GitHub account each purchase gives access to.
        ShareRepo never stores their email addresses.
      </p>
      {customers.length === 0 ? (
        <p className="mt-6 text-gray-600">No customers yet.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {customers.map((customer) => (
            <CustomerCard
              key={customer.id}
              customer={customer}
              result={actionData?.customerId === customer.id ? actionData : null}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function CustomerCard(props: {
  customer: CustomerSummary;
  result: { ok: boolean; notice: string | null; error: string | null } | null;
}) {
  const { customer, result } = props;
  const navigation = useNavigation();
  return (
    <li className="rounded border border-gray-200 p-4" aria-label={customer.externalCustomerId}>
      <h2 className="font-mono text-base font-semibold">{customer.externalCustomerId}</h2>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-600">Source</dt>
        <dd>{customer.source === "paddle" ? "Paddle" : "Simulated"}</dd>
        <dt className="text-gray-600">GitHub account</dt>
        <dd>{customer.linked === null ? "Not claimed" : `@${customer.linked.login}`}</dd>
        <dt className="text-gray-600">Subscriptions</dt>
        <dd>
          {customer.subscriptions.length === 0 ? (
            "None"
          ) : (
            <ul>
              {customer.subscriptions.map((subscription) => (
                <li key={subscription.id}>
                  <span className="font-mono">{subscription.externalSubscriptionId}</span>:{" "}
                  {SUBSCRIPTION_STATE_LABELS[subscription.state]}
                  {subscription.cancelAt !== null &&
                    subscription.endedAt === null &&
                    `, cancels ${formatDate(subscription.cancelAt)}`}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {result?.ok && (
        <p role="status" className="mt-3 text-green-800">
          {result.notice}
        </p>
      )}
      {result !== null && !result.ok && (
        <p role="alert" className="mt-3 text-red-700">
          {result.error}
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm underline">Link to a GitHub account</summary>
        <Form method="post" className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-gray-600">
            For repair only, for example when a subscriber can't claim their purchase. The link and
            your reason are recorded. An existing link moves to the new account.
          </p>
          <input type="hidden" name="customerId" value={customer.id} />
          <TextField name="githubLogin" label="GitHub login" isRequired className="max-w-xs" />
          <TextField name="reason" label="Reason" isRequired />
          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="self-start rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
          >
            Link customer
          </button>
        </Form>
      </details>
    </li>
  );
}
