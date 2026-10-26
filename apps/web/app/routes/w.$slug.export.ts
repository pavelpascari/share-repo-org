import { exportWorkspace } from "@sharerepo/application";
import { data } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { formatInstant } from "../entitlement-messages.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.export";

/**
 * The workspace export (decision 0015, threat O7): an owner's same-origin POST answered with the
 * JSON file as an attachment. No CORS headers, so another site cannot read it; never cached.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await requireUser(request, context);
  const services = servicesFor(context);
  const result = await exportWorkspace(services, user, params.slug).catch((error: unknown) => {
    throw asResponse(error);
  });
  if (!result.ok) {
    throw data(
      { message: `Export limit reached. Try again after ${formatInstant(result.retryAt)}.` },
      {
        status: 429,
        headers: {
          "retry-after": String(Math.ceil((result.retryAt - services.clock.now()) / 1000)),
        },
      },
    );
  }
  return new Response(JSON.stringify(result.document, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Only POST starts an export; a GET of this URL is not a page. */
export function loader() {
  throw data(null, { status: 405, headers: { allow: "POST" } });
}
