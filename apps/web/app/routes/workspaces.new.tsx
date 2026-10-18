import { createWorkspace } from "@sharerepo/application";
import { Form, redirect } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { fieldMessages } from "../workspace-messages.ts";
import { lastWorkspaceCookie } from "../workspaces.server.ts";
import type { Route } from "./+types/workspaces.new";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Create a workspace · ShareRepo" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await requireUser(request, context);
  const form = await request.formData();
  const input = { name: String(form.get("name") ?? ""), slug: String(form.get("slug") ?? "") };
  const result = await createWorkspace(servicesFor(context), user, input);
  if (!result.ok) return { input, errors: fieldMessages(result.errors) };
  const { slug } = result.workspace;
  throw redirect(`/w/${slug}`, {
    headers: { "set-cookie": await lastWorkspaceCookie(context).serialize(slug) },
  });
}

export default function NewWorkspace({ actionData }: Route.ComponentProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Create a workspace</h1>
      <Form method="post" className="mt-6 flex flex-col gap-4">
        <TextField
          name="name"
          label="Name"
          isRequired
          defaultValue={actionData?.input.name ?? ""}
          error={actionData?.errors.name}
        />
        <TextField
          name="slug"
          label="URL"
          description="Lowercase letters, numbers and hyphens, for example acme-labs."
          isRequired
          defaultValue={actionData?.input.slug ?? ""}
          error={actionData?.errors.slug}
        />
        <button type="submit" className="self-start rounded bg-gray-900 px-4 py-2 text-white">
          Create workspace
        </button>
      </Form>
    </>
  );
}
