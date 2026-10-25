import {
  cancelWorkspaceDeletion,
  getWorkspaceSettings,
  renameWorkspace,
  requestWorkspaceDeletion,
} from "@sharerepo/application";
import type { PurgeBlock } from "@sharerepo/domain";
import { data, Form } from "react-router";
import { z } from "zod";
import { servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { commerceFor } from "../commerce.server.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { formatDate } from "../entitlement-messages.ts";
import { PURGE_BLOCK_MESSAGES } from "../failure-messages.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { fieldMessages } from "../workspace-messages.ts";
import { asResponse } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.settings";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Settings · ShareRepo" }];
}

/** The owner's settings, for an active workspace or one being deleted. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = await requireUser(request, context);
  return getWorkspaceSettings(servicesFor(context), user, params.slug).catch((error: unknown) => {
    throw asResponse(error);
  });
}

const intentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("rename"), name: z.string().max(1000) }),
  z.object({ intent: z.literal("delete"), confirmation: z.string().max(200) }),
  z.object({ intent: z.literal("cancel_deletion") }),
]);

type ActionData =
  | { intent: "rename"; saved: boolean; errors: { name?: string } }
  | {
      intent: "delete";
      ok: boolean;
      error: string | null;
      orphanedDestinationId: string | null;
    }
  | { intent: "cancel_deletion"; ok: boolean };

/** Owner only: `rename`, `delete` (confirmed by the slug), `cancel_deletion`. */
export async function action({ request, params, context }: Route.ActionArgs): Promise<ActionData> {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await requireUser(request, context);
  const services = servicesFor(context);
  try {
    // Authorized before the form is read: a stranger learns nothing from a malformed post.
    await getWorkspaceSettings(services, user, params.slug);
    // A form without an intent is the rename form of earlier versions.
    const parsed = intentSchema.safeParse({
      intent: "rename",
      ...Object.fromEntries(await request.formData()),
    });
    if (!parsed.success) throw data(null, { status: 400 });
    const form = parsed.data;
    if (form.intent === "rename") {
      const result = await renameWorkspace(services, user, params.slug, { name: form.name });
      return result.ok
        ? { intent: "rename", saved: true, errors: {} }
        : { intent: "rename", saved: false, errors: fieldMessages(result.errors) };
    }
    if (form.intent === "delete") {
      const result = await requestWorkspaceDeletion(
        services,
        user,
        params.slug,
        { confirmation: form.confirmation },
        commerceFor(context),
      );
      if (result.ok) {
        return {
          intent: "delete",
          ok: true,
          error: null,
          orphanedDestinationId: result.orphanedDestinationId,
        };
      }
      return {
        intent: "delete",
        ok: false,
        error:
          result.reason === "confirmation_mismatch"
            ? "Type the workspace's URL name exactly to confirm."
            : "This workspace is already being deleted.",
        orphanedDestinationId: null,
      };
    }
    const result = await cancelWorkspaceDeletion(services, user, params.slug);
    return { intent: "cancel_deletion", ok: result.ok };
  } catch (error) {
    throw asResponse(error);
  }
}

export default function WorkspaceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace, deletion } = loaderData;
  const renamed = actionData?.intent === "rename" ? actionData : null;
  const deleted = actionData?.intent === "delete" ? actionData : null;
  return (
    <>
      <h1 className="text-2xl font-semibold">Settings</h1>
      {deletion === null ? (
        <Form method="post" className="mt-6 flex flex-col gap-4">
          <input type="hidden" name="intent" value="rename" />
          <TextField
            name="name"
            label="Workspace name"
            isRequired
            defaultValue={workspace.name}
            error={renamed?.errors.name}
          />
          <button type="submit" className="self-start rounded bg-gray-900 px-4 py-2 text-white">
            Save
          </button>
          {renamed?.saved && <p role="status">Saved.</p>}
        </Form>
      ) : (
        <DeletionBanner
          deleteAfter={deletion.deleteAfter}
          blocked={deletion.blocked?.reason ?? null}
        />
      )}
      {deleted?.ok && deleted.orphanedDestinationId !== null && (
        <p role="alert" className="mt-4 text-amber-800">
          ShareRepo couldn't delete its notification destination{" "}
          <code>{deleted.orphanedDestinationId}</code> in Paddle. Delete it in Paddle under
          Developer tools › Notifications.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Export</h2>
        <p className="mt-1 text-gray-700">
          Download this workspace's repositories, offers, customers, subscriptions, access and
          history as one JSON file. Credentials and buyers' email addresses are never included. You
          can export 5 times an hour.
        </p>
        {/* A plain form: the browser downloads the file the action returns. */}
        <form method="post" action={`/w/${workspace.slug}/export`} className="mt-3">
          <button type="submit" className="rounded border border-gray-400 px-4 py-2">
            Download export
          </button>
        </form>
      </section>

      {deletion === null ? (
        <section className="mt-10 rounded border border-red-300 p-4">
          <h2 className="text-lg font-semibold text-red-800">Delete workspace</h2>
          <p className="mt-1 text-gray-700">
            ShareRepo ends every subscriber's access and removes the collaborators it invited. The
            workspace becomes read-only, and its data is deleted after 30 days. Until then you can
            cancel. Checkout and claims stop at once, and Paddle is disconnected.
          </p>
          <Form method="post" className="mt-4 flex flex-col gap-3">
            <input type="hidden" name="intent" value="delete" />
            <TextField
              name="confirmation"
              label={`Type ${workspace.slug} to confirm`}
              isRequired
              autoComplete="off"
              error={deleted?.error ?? undefined}
            />
            <button type="submit" className="self-start rounded bg-red-700 px-4 py-2 text-white">
              Delete workspace
            </button>
          </Form>
        </section>
      ) : (
        <Form method="post" className="mt-6">
          <input type="hidden" name="intent" value="cancel_deletion" />
          <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-white">
            Cancel deletion
          </button>
          {actionData?.intent === "cancel_deletion" && !actionData.ok && (
            <p role="alert" className="mt-2 text-red-700">
              This workspace is no longer being deleted.
            </p>
          )}
        </Form>
      )}
    </>
  );
}

function DeletionBanner(props: { deleteAfter: number; blocked: PurgeBlock | null }) {
  return (
    <div role="status" className="mt-6 rounded border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium">
        This workspace is being deleted. Its data will be deleted after{" "}
        {formatDate(props.deleteAfter)}.
      </p>
      <p className="mt-2 text-gray-700">
        Subscribers' access is being ended, and the workspace is read-only. Once it is deleted,
        uninstall the ShareRepo GitHub App from your GitHub account (Settings › Applications):
        ShareRepo does not remove the installation itself.
      </p>
      {props.blocked !== null && (
        <p className="mt-2 text-amber-900">Waiting: {PURGE_BLOCK_MESSAGES[props.blocked]}</p>
      )}
    </div>
  );
}
