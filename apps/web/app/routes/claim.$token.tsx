import { confirmClaim, viewClaim } from "@sharerepo/application";
import { ConflictError } from "@sharerepo/platform";
import { data, Form, Link, useNavigation } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { getSignedInUser } from "../auth/session.server.ts";
import { CLAIM_ERRORS } from "../commerce-messages.ts";
import { GitHubAccount, SignInPrompt } from "../components/sign-in-prompt.tsx";
import { cloudflareContext } from "../context.ts";
import { CONFLICT_MESSAGE } from "../entitlement-messages.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/claim.$token";

// The emailed claim link (decision 0012, path 2). The path carries a one-time token: the page
// never sends a referrer (threat T2), the request log shows `/claim/:token`, and GET only renders
// a confirmation (threat T3); the claim happens on a same-origin POST.

const REFERRER_POLICY = { "Referrer-Policy": "no-referrer" } as const;
const REFERRER_INIT = { headers: REFERRER_POLICY };

export function headers(_: Route.HeadersArgs) {
  return REFERRER_POLICY;
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Claim a purchase · ShareRepo" }, { name: "referrer", content: "no-referrer" }];
}

/** Reads only: a mail scanner opening the link consumes and records nothing. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = await getSignedInUser(request, context);
  const returnTo = new URL(request.url).pathname;
  if (user === null) {
    return data({ signedIn: false as const, returnTo, view: null, error: null }, REFERRER_INIT);
  }
  const result = await viewClaim(servicesFor(context), { token: params.token, user }).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return data(
    {
      signedIn: true as const,
      returnTo,
      view: result.ok ? result.view : null,
      error: result.ok ? null : CLAIM_ERRORS[result.reason],
    },
    REFERRER_INIT,
  );
}

type ActionData =
  | { ok: true; workspaceSlug: string; outcome: string; error: null }
  | { ok: false; error: string };

/** Links the purchase to the signed-in user's GitHub account, consuming the token. */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await getSignedInUser(request, context);
  if (user === null) throw data(null, { status: 401, headers: REFERRER_POLICY });
  let result: Awaited<ReturnType<typeof confirmClaim>>;
  try {
    result = await confirmClaim(servicesFor(context), { token: params.token, user });
  } catch (error) {
    if (error instanceof ConflictError) {
      return data({ ok: false, error: CONFLICT_MESSAGE } satisfies ActionData, REFERRER_INIT);
    }
    throw asResponse(error);
  }
  const body: ActionData = result.ok
    ? { ok: true, workspaceSlug: result.workspaceSlug, outcome: result.outcome, error: null }
    : { ok: false, error: CLAIM_ERRORS[result.reason] };
  return data(body, REFERRER_INIT);
}

export default function Claim({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const heading = "Claim a purchase";
  if (!loaderData.signedIn) {
    return (
      <SignInPrompt
        heading={heading}
        message="Sign in with GitHub to claim this purchase. The GitHub account you sign in with receives access to the repositories."
        returnTo={loaderData.returnTo}
      />
    );
  }
  if (actionData?.ok) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Purchase claimed</h1>
        <p role="status" className="mt-2 text-green-800">
          {actionData.outcome === "already_linked"
            ? "This purchase was already linked to your GitHub account."
            : "Your purchase is linked to your GitHub account. You'll get an invitation to each repository on GitHub shortly."}
        </p>
        <Link to="/me/access" className="mt-4 inline-block underline">
          See my access
        </Link>
      </>
    );
  }
  const { view } = loaderData;
  const error = actionData?.ok === false ? actionData.error : loaderData.error;
  return (
    <>
      <h1 className="text-2xl font-semibold">{heading}</h1>
      {error !== null && (
        <p role="alert" className="mt-4 text-red-700">
          {error}
        </p>
      )}
      {view !== null && (
        <>
          <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-gray-600">Creator</dt>
            <dd>{view.workspace.name}</dd>
            <dt className="text-gray-600">Offers</dt>
            <dd>{view.offers.length === 0 ? "None at the moment" : view.offers.join(", ")}</dd>
          </dl>
          <GitHubAccount login={view.account.login} avatarUrl={view.account.avatarUrl} />
          {view.linked === "other" && (
            <p className="mt-4 text-amber-800">
              This purchase is linked to another GitHub account now. Claiming it moves the access to
              @{view.account.login}, and the other account loses it.
            </p>
          )}
          {view.linked === "you" && (
            <p className="mt-4 text-gray-700">This purchase is already linked to your account.</p>
          )}
          <Form method="post" className="mt-6">
            <button
              type="submit"
              disabled={navigation.state !== "idle"}
              className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
            >
              Claim purchase
            </button>
          </Form>
        </>
      )}
    </>
  );
}
