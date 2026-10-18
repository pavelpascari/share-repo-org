import {
  completeGitHubConnection,
  refreshInstallationForMember,
  resyncConnection,
} from "@sharerepo/application";
import { data, redirect } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { githubFor } from "../github.server.ts";
import type { Route } from "./+types/github.setup";

/**
 * GitHub's Setup URL. Safe as a GET: it only completes the signed-in user's own single-use
 * intent (the `state`), so a forged or replayed link attaches nothing.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await requireUser(request, context);
  const github = githubFor(context);
  if (github === null) throw data(null, { status: 503 });
  const url = new URL(request.url);
  const services = servicesFor(context);
  const state = url.searchParams.get("state");
  const installationId = url.searchParams.get("installation_id") ?? "";
  if (state === null && url.searchParams.get("setup_action") === "update") {
    // The owner changed the selection on GitHub: refresh, but never attach without an intent.
    const refreshed = await refreshInstallationForMember(services, user, installationId, github);
    return redirect(
      refreshed === null
        ? "/?github_error=invalid_state"
        : `/w/${refreshed.workspaceSlug}/repositories`,
    );
  }
  const result = await completeGitHubConnection(
    services,
    user,
    {
      state: state ?? "",
      installationId,
    },
    github,
  );
  if (!result.ok) {
    context.get(cloudflareContext).logger.warn("github setup refused", { reason: result.reason });
    return redirect(`/?github_error=${result.reason}`);
  }
  // Show repositories right away; the outbox resync is the fallback if this fails.
  await resyncConnection(
    services,
    { workspaceId: result.workspaceId, id: result.connectionId },
    github,
    "connected",
  ).catch(() => context.get(cloudflareContext).logger.warn("initial resync deferred"));
  return redirect(`/w/${result.workspaceSlug}/repositories`);
}
