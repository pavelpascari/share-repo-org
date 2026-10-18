import { authFor } from "../auth/server.ts";
import type { Route } from "./+types/api.auth.callback";

/** GitHub redirects here after authorization; Better Auth verifies state and PKCE. */
export function loader({ request, context }: Route.LoaderArgs) {
  return authFor(context).handler(request);
}
