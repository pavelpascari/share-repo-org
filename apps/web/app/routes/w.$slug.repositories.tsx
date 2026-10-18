import {
  listGitHubConnections,
  resyncWorkspaceConnections,
  startGitHubConnection,
} from "@sharerepo/application";
import { Checkbox } from "react-aria-components";
import { data, Form, redirect, useRouteLoaderData } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { githubFor } from "../github.server.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.repositories";
import type { loader as workspaceLoader } from "./w.$slug.tsx";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Repositories · ShareRepo" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = await requireUser(request, context);
  const connections = await listGitHubConnections(servicesFor(context), user, params.slug).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return {
    connections,
    githubConfigured: githubFor(context) !== null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await requireUser(request, context);
  const github = githubFor(context);
  if (github === null) throw data(null, { status: 503 });
  const form = await request.formData();
  const services = servicesFor(context);
  try {
    if (form.get("intent") === "resync") {
      await resyncWorkspaceConnections(services, user, params.slug, github);
      return { error: null };
    }
    const started = await startGitHubConnection(
      services,
      user,
      params.slug,
      { acknowledgeWriteAccess: form.get("acknowledge") === "on" },
      github,
    );
    if (!started.ok) return { error: "Confirm that subscribers will get write access." };
    throw redirect(started.installUrl);
  } catch (error) {
    throw asResponse(error);
  }
}

const STATUS_NOTES = {
  active: null,
  suspended: "The GitHub App is suspended on this account. Unsuspend it on GitHub to resume.",
  deleted: "The GitHub App was uninstalled. Connect GitHub again to sell these repositories.",
} as const;

export default function Repositories({ loaderData, actionData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof workspaceLoader>("routes/w.$slug");
  const isOwner = layout?.workspace.role === "owner";
  const { connections, githubConfigured } = loaderData;
  const active = connections.filter((connection) => connection.status !== "deleted");
  return (
    <>
      <h1 className="text-2xl font-semibold">Repositories</h1>
      {connections.map((connection) => (
        <section key={connection.id} className="mt-6">
          <h2 className="text-lg font-semibold">GitHub: {connection.accountLogin}</h2>
          {STATUS_NOTES[connection.status] !== null && (
            <p role="status" className="mt-1 text-amber-800">
              {STATUS_NOTES[connection.status]}
            </p>
          )}
          {connection.repositories.length === 0 ? (
            <p className="mt-2 text-gray-600">No repositories selected yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {connection.repositories.map((repository) => (
                <li key={repository.id} className="flex gap-2">
                  <span>{repository.name}</span>
                  <span className="text-sm text-gray-600">
                    {repository.sellable
                      ? "Ready to sell"
                      : repository.selection === "removed"
                        ? "Removed from the App"
                        : repository.archived
                          ? "Archived"
                          : !repository.private
                            ? "Public: not sellable"
                            : "Unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {isOwner && githubConfigured && active.length > 0 && (
        <Form method="post" className="mt-6">
          <button type="submit" name="intent" value="resync" className="text-sm underline">
            Refresh from GitHub
          </button>
        </Form>
      )}
      {isOwner && githubConfigured && active.length === 0 && (
        <Form method="post" className="mt-8 flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Connect GitHub</h2>
          <p className="text-gray-700">
            ShareRepo adds subscribers as collaborators on your repositories. On a personal GitHub
            account, collaborators always get <strong>write access</strong>: they can push, merge,
            publish releases and read Actions secrets. Sell a distribution copy, protect its default
            branch, and keep no secrets in it.
          </p>
          <Checkbox name="acknowledge" value="on" className="flex items-center gap-2">
            I understand that subscribers get write access to the repositories I sell.
          </Checkbox>
          {actionData?.error && (
            <p role="alert" className="text-red-700">
              {actionData.error}
            </p>
          )}
          <button
            type="submit"
            name="intent"
            value="connect"
            className="self-start rounded bg-gray-900 px-4 py-2 text-white"
          >
            Connect GitHub
          </button>
        </Form>
      )}
      {!githubConfigured && (
        <p className="mt-6 text-gray-600">
          The GitHub App is not configured for this environment (see
          docs/runbooks/github-app-setup.md).
        </p>
      )}
    </>
  );
}
