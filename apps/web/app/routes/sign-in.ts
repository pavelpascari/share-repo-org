import { startGitHubSignIn } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import type { Route } from "./+types/sign-in";

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  return startGitHubSignIn(request, context);
}
