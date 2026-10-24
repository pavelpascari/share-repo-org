import { requestClaim } from "@sharerepo/application";
import { data, Form, useNavigation } from "react-router";
import { z } from "zod";
import { CLIENT_IP_HEADER } from "../auth/auth.ts";
import { servicesFor } from "../auth/server.ts";
import { getSignedInUser } from "../auth/session.server.ts";
import { commerceFor, enqueueOutboxById } from "../commerce.server.ts";
import { CLAIM_EMAIL_UNAVAILABLE, CLAIM_REQUESTED } from "../commerce-messages.ts";
import { SignInPrompt } from "../components/sign-in-prompt.tsx";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/c.$slug.claim";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Claim a purchase · ShareRepo" }];
}

/** Claiming by email is possible only with Paddle's keys and a mail transport configured. */
function available(context: Route.LoaderArgs["context"]): boolean {
  return commerceFor(context) !== null && context.get(cloudflareContext).env.mail !== null;
}

/**
 * The workspace's claim page (decision 0012, path 2): a buyer who paid through a link the creator
 * shared asks for a claim link at the email they paid with. Reads nothing about purchases.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await getSignedInUser(request, context);
  return {
    signedIn: user !== null,
    returnTo: new URL(request.url).pathname,
    available: available(context),
  };
}

const claimForm = z.object({ email: z.string().max(320) });

type ActionData = { requested: true; error: null } | { requested: false; error: string };

/**
 * Always the same confirmation, whether or not a purchase matches or the request was rate
 * limited (threats T4, T5). The queue hand-off happens off the response path.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await getSignedInUser(request, context);
  if (user === null) throw data(null, { status: 401 });
  const commerce = commerceFor(context);
  if (commerce === null || !available(context)) {
    return { requested: false, error: CLAIM_EMAIL_UNAVAILABLE } satisfies ActionData;
  }
  const parsed = claimForm.safeParse({ email: (await request.formData()).get("email") ?? "" });
  const invalid = { requested: false, error: "Enter the email address you paid with." } as const;
  if (!parsed.success) return invalid satisfies ActionData;
  const result = await requestClaim(
    servicesFor(context),
    {
      workspaceSlug: params.slug,
      email: parsed.data.email,
      user,
      ip: request.headers.get(CLIENT_IP_HEADER) ?? "unknown",
    },
    commerce,
  ).catch((error: unknown) => {
    throw asResponse(error);
  });
  if (result.status === "invalid_email") return invalid satisfies ActionData;
  if (result.outboxId !== null) enqueueOutboxById(context, result.outboxId);
  return { requested: true, error: null } satisfies ActionData;
}

export default function ClaimRequest({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const heading = "Claim a purchase";
  if (!loaderData.signedIn) {
    return (
      <SignInPrompt
        heading={heading}
        message="Paid for a subscription with a link from the creator? Sign in with GitHub to claim it. The GitHub account you sign in with receives access to the repositories."
        returnTo={loaderData.returnTo}
      />
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold">{heading}</h1>
      <p className="mt-2 text-gray-700">
        Enter the email address you paid with. If it matches a purchase, we email you a link to
        claim it for your GitHub account.
      </p>
      {!loaderData.available ? (
        <p className="mt-6 text-gray-700">{CLAIM_EMAIL_UNAVAILABLE}</p>
      ) : actionData?.requested ? (
        <p role="status" className="mt-6 text-green-800">
          {CLAIM_REQUESTED}
        </p>
      ) : (
        <Form method="post" className="mt-6 flex flex-col gap-4">
          <TextField
            name="email"
            label="Email address"
            type="email"
            autoComplete="email"
            isRequired
            error={actionData?.error ?? undefined}
            className="max-w-md"
          />
          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="self-start rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
          >
            Send claim link
          </button>
        </Form>
      )}
    </>
  );
}
