import { getCheckoutView, startCheckout } from "@sharerepo/application";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { data, Form, redirect, useNavigation } from "react-router";
import { z } from "zod";
import { CLIENT_IP_HEADER } from "../auth/auth.ts";
import { servicesFor } from "../auth/server.ts";
import { getSignedInUser } from "../auth/session.server.ts";
import { attemptPaddle, commerceFor } from "../commerce.server.ts";
import {
  CHECKOUT_ERRORS,
  CHECKOUT_FAILED,
  PADDLE_NOT_CONFIGURED,
  priceLabel,
} from "../commerce-messages.ts";
import { GitHubAccount, SignInPrompt } from "../components/sign-in-prompt.tsx";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/buy.$offerId";

export function meta({ loaderData }: Route.MetaArgs) {
  const view = loaderData?.view;
  return [{ title: view ? `${view.offer.name} · ShareRepo` : "Checkout · ShareRepo" }];
}

/** The offer's checkout page (decision 0012, path 1). Signed out: sign in, then come back. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = await getSignedInUser(request, context);
  const returnTo = new URL(request.url).pathname;
  if (user === null) return { signedIn: false as const, returnTo, view: null, unavailable: false };
  const result = await getCheckoutView(servicesFor(context), {
    offerId: params.offerId,
    user,
  }).catch((error: unknown) => {
    throw asResponse(error);
  });
  if (!result.ok && result.reason === "not_found") throw data(null, { status: 404 });
  return {
    signedIn: true as const,
    returnTo,
    view: result.ok ? result.view : null,
    unavailable: !result.ok,
  };
}

const checkoutForm = z.object({ priceId: z.string().min(1).max(128) });

/** Starts checkout for the chosen price and sends the buyer to Paddle's checkout. */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await getSignedInUser(request, context);
  if (user === null) throw data(null, { status: 401 });
  const commerce = commerceFor(context);
  if (commerce === null) return { error: PADDLE_NOT_CONFIGURED };
  const parsed = checkoutForm.safeParse({ priceId: (await request.formData()).get("priceId") });
  if (!parsed.success) return { error: CHECKOUT_ERRORS.price_invalid };
  const attempted = await attemptPaddle(
    () =>
      startCheckout(
        servicesFor(context),
        {
          offerId: params.offerId,
          priceId: parsed.data.priceId,
          user,
          ip: request.headers.get(CLIENT_IP_HEADER) ?? "unknown",
        },
        commerce,
      ),
    CHECKOUT_FAILED,
  );
  if (!attempted.ok) return { error: attempted.error };
  const result = attempted.value;
  if (result.ok) throw redirect(result.checkoutUrl);
  if (result.reason === "not_found") throw data(null, { status: 404 });
  return { error: CHECKOUT_ERRORS[result.reason] };
}

export default function Buy({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  if (!loaderData.signedIn) {
    return (
      <SignInPrompt
        heading="Subscribe"
        message="Sign in with GitHub to subscribe. The GitHub account you sign in with receives access to the repositories."
        returnTo={loaderData.returnTo}
      />
    );
  }
  const { view } = loaderData;
  if (view === null) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Subscribe</h1>
        <p className="mt-2 text-gray-700">{CHECKOUT_ERRORS.unavailable}</p>
      </>
    );
  }
  const [first] = view.prices;
  return (
    <>
      <h1 className="text-2xl font-semibold">{view.offer.name}</h1>
      <p className="mt-1 text-gray-600">From {view.workspace.name}</p>
      <h2 className="mt-6 font-semibold">Repositories</h2>
      <ul className="mt-1 list-disc pl-6">
        {view.repositories.map((name) => (
          <li key={name} className="font-mono text-sm">
            {name}
          </li>
        ))}
      </ul>
      <GitHubAccount login={view.account.login} avatarUrl={view.account.avatarUrl} />
      <p className="mt-2 text-sm text-gray-600">
        Not the right account? Sign out and sign in with the GitHub account that should get access.
      </p>
      {actionData?.error !== undefined && (
        <p role="alert" className="mt-4 text-red-700">
          {actionData.error}
        </p>
      )}
      <Form method="post" className="mt-6 flex flex-col gap-4">
        <RadioGroup
          name="priceId"
          defaultValue={first?.priceId ?? null}
          isRequired
          className="flex flex-col gap-2"
        >
          <Label className="font-semibold">Price</Label>
          {view.prices.map((price) => (
            <Radio
              key={price.priceId}
              value={price.priceId}
              className="flex items-center gap-2 before:block before:h-4 before:w-4 before:rounded-full before:border before:border-gray-500 data-[selected]:before:border-4 data-[selected]:before:border-gray-900"
            >
              {priceLabel(price)}
            </Radio>
          ))}
        </RadioGroup>
        <button
          type="submit"
          disabled={navigation.state !== "idle"}
          className="self-start rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
        >
          Continue to checkout
        </button>
        <p className="text-sm text-gray-600">
          Payment is handled by Paddle. After paying, you get an invitation to each repository on
          GitHub.
        </p>
      </Form>
    </>
  );
}
