import { renameWorkspace } from "@sharerepo/application";
import { Form } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { fieldMessages } from "../workspace-messages.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.settings";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  return loadWorkspace(request, context, params.slug, "workspace.manage");
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const { user } = await loadWorkspace(request, context, params.slug, "workspace.manage");
  const name = String((await request.formData()).get("name") ?? "");
  const result = await renameWorkspace(servicesFor(context), user, params.slug, { name }).catch(
    (error: unknown) => {
      throw asResponse(error);
    },
  );
  return result.ok
    ? { saved: true, errors: {} }
    : { saved: false, errors: fieldMessages(result.errors) };
}

export default function WorkspaceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Form method="post" className="mt-6 flex flex-col gap-4">
        <TextField
          name="name"
          label="Workspace name"
          isRequired
          defaultValue={workspace.name}
          error={actionData?.errors.name}
        />
        <button type="submit" className="self-start rounded bg-gray-900 px-4 py-2 text-white">
          Save
        </button>
        {actionData?.saved && <p role="status">Saved.</p>}
      </Form>
    </>
  );
}
