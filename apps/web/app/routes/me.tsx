import { deleteAccount, getAccountView } from "@sharerepo/application";
import { data, Form, Link, redirect } from "react-router";
import { z } from "zod";
import { authFor, servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { lastWorkspaceCookie } from "../workspaces.server.ts";
import type { Route } from "./+types/me";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Account · ShareRepo" }];
}

/** The signed-in user's account: who they are, and deleting it. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await requireUser(request, context);
  return getAccountView(servicesFor(context), user);
}

const deleteForm = z.object({ intent: z.literal("delete"), confirmation: z.string().max(200) });

/**
 * Deletes the signed-in user's own account (decision 0015, threat O12), confirmed by their GitHub
 * login. On success the session cookies are cleared and the browser goes home.
 */
export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const user = await requireUser(request, context);
  const parsed = deleteForm.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) throw data(null, { status: 400 });
  const result = await deleteAccount(servicesFor(context), user, {
    confirmation: parsed.data.confirmation,
  });
  if (!result.ok) {
    return {
      error:
        result.reason === "confirmation_mismatch"
          ? "Type your GitHub login exactly to confirm."
          : "Delete the workspaces you own first.",
    };
  }
  // The sessions are gone with the account; this clears the browser's cookies.
  const signedOut = await authFor(context).api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  const headers = new Headers();
  for (const cookie of signedOut.headers.getSetCookie()) headers.append("set-cookie", cookie);
  headers.append("set-cookie", await lastWorkspaceCookie(context).serialize("", { maxAge: 0 }));
  return redirect("/?account=deleted", { headers });
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const { login, blockingWorkspaces } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">Account</h1>
      {login !== null && (
        <p className="mt-2 text-gray-700">
          Signed in with the GitHub account <strong>{login}</strong>.
        </p>
      )}
      <section className="mt-10 rounded border border-red-300 p-4">
        <h2 className="text-lg font-semibold text-red-800">Delete account</h2>
        <p className="mt-1 text-gray-700">
          ShareRepo removes the repository access it gave your GitHub account, forgets your
          purchases' links to it, and deletes your account. Creators keep a record of your GitHub
          account for their own history. To buy access again, sign in and claim your purchase again.
        </p>
        {blockingWorkspaces.length > 0 ? (
          <div className="mt-4">
            <p>You own these workspaces. Delete them first:</p>
            <ul className="mt-2 list-disc pl-6">
              {blockingWorkspaces.map((workspace) => (
                <li key={workspace.slug}>
                  <Link to={`/w/${workspace.slug}/settings`} className="underline">
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          login !== null && (
            <Form method="post" className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="intent" value="delete" />
              <TextField
                name="confirmation"
                label={`Type ${login} to confirm`}
                isRequired
                autoComplete="off"
                error={actionData?.error}
              />
              <button type="submit" className="self-start rounded bg-red-700 px-4 py-2 text-white">
                Delete my account
              </button>
            </Form>
          )
        )}
        {blockingWorkspaces.length > 0 && actionData?.error !== undefined && (
          <p role="alert" className="mt-2 text-red-700">
            {actionData.error}
          </p>
        )}
      </section>
    </>
  );
}
