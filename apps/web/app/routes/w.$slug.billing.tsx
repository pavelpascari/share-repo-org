import {
  type BillingView,
  type ConnectPaddleResult,
  connectPaddle,
  disconnectPaddle,
  getBillingView,
  PADDLE_REQUIRED_PERMISSIONS,
  type ReconnectPaddleResult,
  reconnectPaddle,
  rotatePaddleWebhookSecret,
  syncPaddleCatalog,
} from "@sharerepo/application";
import { data, Form, Link, useNavigation } from "react-router";
import { z } from "zod";
import { servicesFor } from "../auth/server.ts";
import { attemptPaddle, commerceFor } from "../commerce.server.ts";
import {
  PADDLE_NOT_CONFIGURED,
  PADDLE_STATUS_LABELS,
  PADDLE_UNREACHABLE,
  paddleKeyErrorMessage,
  paddleStatusReasonText,
  priceText,
  WEBHOOK_ROTATED,
  WEBHOOK_ROTATION_ERRORS,
} from "../commerce-messages.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { formatDate, formatInstant } from "../entitlement-messages.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.billing";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Billing · ShareRepo" }];
}

/** Production sells for real with live keys; every other environment uses Paddle's sandbox. */
const paddleEnvironment = (deployment: string) =>
  deployment === "production" ? ("live" as const) : ("sandbox" as const);

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.manage");
  const commerce = commerceFor(context);
  const services = servicesFor(context);
  const view: BillingView | null =
    commerce === null
      ? null
      : await getBillingView(services, user, params.slug).catch((error: unknown) => {
          throw asResponse(error);
        });
  return {
    configured: commerce !== null,
    view,
    environment: paddleEnvironment(context.get(cloudflareContext).env.ENVIRONMENT),
    requiredPermissions: PADDLE_REQUIRED_PERMISSIONS,
    confirmDisconnect: new URL(request.url).searchParams.get("disconnect") === "confirm",
    now: services.clock.now(),
  };
}

const keyForm = z.object({
  apiKey: z.string().trim().min(1).max(256),
  apiKeyExpiresOn: z.iso.date(),
});

type ActionData =
  | {
      ok: true;
      notice: string;
      /** After a disconnect that could not delete ShareRepo's destinations in Paddle. */
      orphanedDestinationIds: readonly string[];
      errors: Record<string, never>;
    }
  | {
      ok: false;
      notice: null;
      orphanedDestinationIds: readonly [];
      errors: { form?: string; apiKey?: string; apiKeyExpiresOn?: string };
    };

const failed = (errors: Extract<ActionData, { ok: false }>["errors"]): ActionData => ({
  ok: false,
  notice: null,
  orphanedDestinationIds: [],
  errors,
});
const done = (notice: string, orphanedDestinationIds: readonly string[] = []): ActionData => ({
  ok: true,
  notice,
  orphanedDestinationIds,
  errors: {},
});

/**
 * Owner only: `connect`, `reconnect` (a new key), `refresh` (the catalog), `rotate_webhook` (the
 * webhook secret), `disconnect`.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  assertSameOrigin(request, env.auth.baseURL);
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.manage");
  const commerce = commerceFor(context);
  if (commerce === null) return failed({ form: PADDLE_NOT_CONFIGURED });
  const services = servicesFor(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const environment = paddleEnvironment(env.ENVIRONMENT);

  if (intent === "connect" || intent === "reconnect") {
    const parsed = keyForm.safeParse({
      apiKey: form.get("apiKey") ?? "",
      apiKeyExpiresOn: form.get("apiKeyExpiresOn") ?? "",
    });
    if (!parsed.success) {
      const fields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
      return failed({
        ...(fields.has("apiKey") ? { apiKey: "Paste the API key you created for ShareRepo." } : {}),
        ...(fields.has("apiKeyExpiresOn")
          ? { apiKeyExpiresOn: "Enter the date the key expires, as Paddle shows it." }
          : {}),
      });
    }
    const input = {
      apiKey: parsed.data.apiKey,
      apiKeyExpiresOn: Date.parse(`${parsed.data.apiKeyExpiresOn}T00:00:00Z`),
    };
    const attempted = await attemptPaddle<ConnectPaddleResult | ReconnectPaddleResult>(
      () =>
        intent === "connect"
          ? connectPaddle(services, user, params.slug, input, commerce)
          : reconnectPaddle(services, user, params.slug, input, commerce),
      PADDLE_UNREACHABLE,
    );
    if (!attempted.ok) return failed({ form: attempted.error });
    const result = attempted.value;
    if (!result.ok) {
      const { error } = result;
      const missing = error.reason === "missing_permissions" ? error.missing : [];
      return failed({ form: paddleKeyErrorMessage(error.reason, { environment, missing }) });
    }
    if (intent === "reconnect") return done("Paddle is reconnected with the new API key.");
    return done(
      "catalog" in result && result.catalog === null
        ? "Paddle is connected. The catalog couldn't be imported yet: refresh it below."
        : "Paddle is connected and the catalog is imported.",
    );
  }
  if (intent === "refresh") {
    const attempted = await attemptPaddle(
      () => syncPaddleCatalog(services, user, params.slug, commerce),
      PADDLE_UNREACHABLE,
    );
    if (!attempted.ok) return failed({ form: attempted.error });
    if (!attempted.value.ok) return failed({ form: "Paddle isn't connected." });
    const { added, updated, archived } = attempted.value.summary;
    return done(`Catalog refreshed: ${added} added, ${updated} updated, ${archived} archived.`);
  }
  if (intent === "rotate_webhook") {
    const attempted = await attemptPaddle(
      () => rotatePaddleWebhookSecret(services, user, params.slug, commerce),
      PADDLE_UNREACHABLE,
    );
    if (!attempted.ok) return failed({ form: attempted.error });
    const result = attempted.value;
    if (!result.ok) return failed({ form: WEBHOOK_ROTATION_ERRORS[result.reason] });
    return done(WEBHOOK_ROTATED);
  }
  if (intent === "disconnect") {
    const attempted = await attemptPaddle(
      () => disconnectPaddle(services, user, params.slug, commerce),
      PADDLE_UNREACHABLE,
    );
    if (!attempted.ok) return failed({ form: attempted.error });
    const result = attempted.value;
    if (!result.ok) return failed({ form: "Paddle isn't connected." });
    return done(
      "Paddle is disconnected. Subscribers keep their history; ShareRepo no longer reads Paddle.",
      result.orphanedDestinationIds,
    );
  }
  throw data(null, { status: 400 });
}

export default function Billing({ loaderData, actionData }: Route.ComponentProps) {
  const { configured, view, confirmDisconnect } = loaderData;
  const connection = view?.connection ?? null;
  return (
    <>
      <h1 className="text-2xl font-semibold">Billing</h1>
      <p className="mt-2 text-gray-700">
        Connect your Paddle account to sell subscriptions to your repositories. Subscribers get
        access when they pay and lose it when their subscription ends.
      </p>
      {actionData?.ok && (
        <p role="status" className="mt-4 text-green-800">
          {actionData.notice}
        </p>
      )}
      {actionData !== undefined && actionData.orphanedDestinationIds.length > 0 && (
        <p role="alert" className="mt-4 text-amber-800">
          ShareRepo couldn't delete its notification{" "}
          {actionData.orphanedDestinationIds.length === 1 ? "destination" : "destinations"}{" "}
          {actionData.orphanedDestinationIds.map((id, index) => (
            <span key={id}>
              {index > 0 && " and "}
              <code>{id}</code>
            </span>
          ))}{" "}
          in Paddle. Delete {actionData.orphanedDestinationIds.length === 1 ? "it" : "them"} in
          Paddle under Developer tools › Notifications.
        </p>
      )}
      {actionData?.errors.form !== undefined && (
        <p role="alert" className="mt-4 text-red-700">
          {actionData.errors.form}
        </p>
      )}
      {!configured ? (
        <p className="mt-6 text-gray-700">{PADDLE_NOT_CONFIGURED}</p>
      ) : connection === null ? (
        <ConnectForm
          environment={loaderData.environment}
          permissions={loaderData.requiredPermissions}
          errors={actionData?.ok === false ? actionData.errors : {}}
        />
      ) : (
        <Connected
          view={view as BillingView}
          now={loaderData.now}
          confirmDisconnect={confirmDisconnect}
          errors={actionData?.ok === false ? actionData.errors : {}}
        />
      )}
    </>
  );
}

function SubmitButton(props: { children: string; danger?: boolean }) {
  const navigation = useNavigation();
  return (
    <button
      type="submit"
      disabled={navigation.state === "submitting"}
      className={`self-start rounded px-4 py-2 text-white disabled:opacity-60 ${props.danger ? "bg-red-700" : "bg-gray-900"}`}
    >
      {props.children}
    </button>
  );
}

function KeyFields(props: { errors: { apiKey?: string; apiKeyExpiresOn?: string } }) {
  return (
    <>
      <TextField
        name="apiKey"
        label="API key"
        type="password"
        autoComplete="off"
        isRequired
        error={props.errors.apiKey}
      />
      <TextField
        name="apiKeyExpiresOn"
        label="Key expiry date"
        type="date"
        isRequired
        description="Paddle shows it when you create the key. ShareRepo reminds you two weeks before."
        error={props.errors.apiKeyExpiresOn}
        className="max-w-xs"
      />
    </>
  );
}

function ConnectForm(props: {
  environment: "sandbox" | "live";
  permissions: readonly string[];
  errors: { apiKey?: string; apiKeyExpiresOn?: string };
}) {
  return (
    <section className="mt-6 flex flex-col gap-4" aria-labelledby="connect-heading">
      <h2 id="connect-heading" className="text-lg font-semibold">
        Connect Paddle
      </h2>
      <p className="text-gray-700">
        In Paddle, create an API key for ShareRepo
        {props.environment === "sandbox" ? " in your sandbox account" : ""} with these permissions:
      </p>
      <ul aria-label="Required permissions" className="list-disc pl-6 font-mono text-sm">
        {props.permissions.map((permission) => (
          <li key={permission}>{permission}</li>
        ))}
      </ul>
      <p className="text-sm text-gray-600">
        <span className="font-mono">account.read</span> is optional: it lets ShareRepo show your
        account's name.
      </p>
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
        ShareRepo registers its own notification destination in your Paddle account, so it receives
        every event in that account, not only events for your repositories. It keeps only each
        event's ID, type and time, never its contents.
      </p>
      <Form method="post" className="flex flex-col gap-4">
        <input type="hidden" name="intent" value="connect" />
        <KeyFields errors={props.errors} />
        <SubmitButton>Connect Paddle</SubmitButton>
      </Form>
    </section>
  );
}

function Connected(props: {
  view: BillingView;
  now: number;
  confirmDisconnect: boolean;
  errors: { apiKey?: string; apiKeyExpiresOn?: string };
}) {
  const connection = props.view.connection as NonNullable<BillingView["connection"]>;
  const expiresOn = connection.apiKeyExpiresOn;
  return (
    <>
      <section aria-labelledby="connection-heading" className="mt-6">
        <h2 id="connection-heading" className="text-lg font-semibold">
          Paddle account
        </h2>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-600">Seller</dt>
          <dd>
            {connection.sellerName === null
              ? connection.sellerId
              : `${connection.sellerName} (${connection.sellerId})`}
          </dd>
          <dt className="text-gray-600">Environment</dt>
          <dd>{connection.environment === "live" ? "Live" : "Sandbox"}</dd>
          <dt className="text-gray-600">Status</dt>
          <dd>{PADDLE_STATUS_LABELS[connection.status]}</dd>
          <dt className="text-gray-600">API key expires</dt>
          <dd>{expiresOn === null ? "Not recorded" : formatDate(expiresOn)}</dd>
          <dt className="text-gray-600">Last event</dt>
          <dd>
            {connection.lastEventAt === null
              ? "No events yet"
              : formatInstant(connection.lastEventAt)}
          </dd>
        </dl>
        {connection.status === "unauthorized" && (
          <p role="alert" className="mt-4 text-red-700">
            {paddleStatusReasonText(connection.statusReason)} ShareRepo keeps subscribers' access as
            it was until you reconnect with a new API key.
          </p>
        )}
        {connection.keyExpiresSoon && expiresOn !== null && (
          <p className="mt-4 text-amber-800">
            Your API key {expiresOn <= props.now ? "expired" : "expires"} on {formatDate(expiresOn)}
            . Create a new key in Paddle and reconnect.
          </p>
        )}
      </section>

      <section aria-labelledby="reconnect-heading" className="mt-8">
        <h2 id="reconnect-heading" className="text-lg font-semibold">
          Reconnect
        </h2>
        <p className="mt-1 text-gray-700">
          Replace the API key with a new one for the same Paddle account, for example before it
          expires.
        </p>
        <Form method="post" className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="intent" value="reconnect" />
          <KeyFields errors={props.errors} />
          <SubmitButton>Reconnect</SubmitButton>
        </Form>
      </section>

      <section aria-labelledby="webhook-heading" className="mt-8">
        <h2 id="webhook-heading" className="text-lg font-semibold">
          Webhook secret
        </h2>
        <p className="mt-1 text-gray-700">
          Paddle signs the events it sends ShareRepo with a secret. Rotate it if you think it
          leaked: ShareRepo adds a new notification destination, then deletes the old one, so no
          event is missed.
        </p>
        {connection.rotationInProgress && (
          <p role="status" className="mt-2 text-amber-800">
            A rotation is in progress: ShareRepo accepts events signed with the old or the new
            secret. Rotate again to finish it.
          </p>
        )}
        <Form method="post" className="mt-3">
          <input type="hidden" name="intent" value="rotate_webhook" />
          <SubmitButton>Rotate webhook secret</SubmitButton>
        </Form>
      </section>

      <Catalog view={props.view} />
      <CheckoutSetup environment={connection.environment} />

      <section aria-labelledby="disconnect-heading" className="mt-10 border-t border-gray-200 pt-6">
        <h2 id="disconnect-heading" className="text-lg font-semibold">
          Disconnect Paddle
        </h2>
        {props.confirmDisconnect ? (
          <Form method="post" className="mt-2 flex flex-col gap-3">
            <p className="text-gray-700">
              ShareRepo stops reading Paddle and deletes its API key and notification destination.
              Subscribers and their subscriptions are kept as history, but Paddle changes no longer
              reach ShareRepo.
            </p>
            <input type="hidden" name="intent" value="disconnect" />
            <div className="flex items-center gap-4">
              <SubmitButton danger>Disconnect Paddle</SubmitButton>
              <Link to="." className="underline">
                Cancel
              </Link>
            </div>
          </Form>
        ) : (
          <Link to="?disconnect=confirm" className="mt-2 inline-block underline">
            Disconnect Paddle…
          </Link>
        )}
      </section>
    </>
  );
}

function Catalog({ view }: { view: BillingView }) {
  const syncedAt = view.connection?.catalogSyncedAt ?? null;
  return (
    <section aria-labelledby="catalog-heading" className="mt-8">
      <h2 id="catalog-heading" className="text-lg font-semibold">
        Catalog
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        {syncedAt === null ? "Not imported yet." : `Imported ${formatInstant(syncedAt)}.`} Offers
        sell active recurring prices.
      </p>
      {view.prices.length === 0 ? (
        <p className="mt-2 text-gray-600">No prices in Paddle yet.</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-1 pr-4">Product</th>
              <th className="py-1 pr-4">Price</th>
              <th className="py-1 pr-4">Price ID</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {view.prices.map((price) => (
              <tr key={price.priceId} className="border-t border-gray-100">
                <td className="py-1 pr-4">
                  {price.productName}
                  {price.description !== null && price.description !== "" && (
                    <span className="block text-gray-600">{price.description}</span>
                  )}
                </td>
                <td className="py-1 pr-4">{priceText(price)}</td>
                <td className="py-1 pr-4 font-mono">{price.priceId}</td>
                <td className="py-1">{price.status === "active" ? "Active" : "Archived"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Form method="post" className="mt-3">
        <input type="hidden" name="intent" value="refresh" />
        <SubmitButton>Refresh catalog</SubmitButton>
      </Form>
    </section>
  );
}

function CheckoutSetup({ environment }: { environment: "sandbox" | "live" }) {
  const snippet = [
    '<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>',
    "<script>",
    ...(environment === "sandbox" ? ['  Paddle.Environment.set("sandbox");'] : []),
    '  Paddle.Initialize({ token: "YOUR_CLIENT_SIDE_TOKEN" });',
    "</script>",
  ].join("\n");
  return (
    <section aria-labelledby="checkout-heading" className="mt-8">
      <h2 id="checkout-heading" className="text-lg font-semibold">
        Checkout page
      </h2>
      <p className="mt-1 text-gray-700">
        Paddle opens checkout on your own website, on the page set as your default payment link.
      </p>
      <ol className="mt-2 list-decimal pl-6 text-gray-700">
        <li>In Paddle, create a client-side token under Developer tools › Authentication.</li>
        <li>
          Add this snippet to a page on a domain Paddle approved for you, with your token in place
          of YOUR_CLIENT_SIDE_TOKEN.
        </li>
        <li>In Paddle, set that page as the default payment link under Checkout settings.</li>
      </ol>
      <pre className="mt-3 overflow-x-auto rounded bg-gray-100 p-3 text-sm">
        <code>{snippet}</code>
      </pre>
    </section>
  );
}
