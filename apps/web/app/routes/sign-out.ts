import { signOut } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { lastWorkspaceCookie } from "../workspaces.server.ts";
import type { Route } from "./+types/sign-out";

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const response = await signOut(request, context);
  // Forget the last workspace too, so a shared browser does not reveal it to the next user.
  response.headers.append(
    "set-cookie",
    await lastWorkspaceCookie(context).serialize("", { maxAge: 0 }),
  );
  return response;
}
