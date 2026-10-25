import { returnToCookie, safeReturnPath } from "../auth/return-to.server.ts";
import { startGitHubSignIn } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import type { Route } from "./+types/sign-in";

/**
 * Starts GitHub sign-in. A `returnTo` path (from a page that needs sign-in) is remembered in a
 * short-lived cookie, and the home page sends the visitor back there once they are signed in.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { baseURL } = context.get(cloudflareContext).env.auth;
  assertSameOrigin(request, baseURL);
  const form = await request.formData().catch(() => new FormData());
  const returnTo = safeReturnPath(form.get("returnTo"), baseURL);
  const response = await startGitHubSignIn(request, context);
  if (returnTo !== null && response.status >= 300 && response.status < 400) {
    response.headers.append("set-cookie", await returnToCookie(context).serialize(returnTo));
  }
  return response;
}
