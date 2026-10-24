import { listMyWorkspaces, openWorkspace } from "@sharerepo/application";
import { Form, Link, redirect } from "react-router";
import { returnToCookie, safeReturnPath } from "../auth/return-to.server.ts";
import { servicesFor } from "../auth/server.ts";
import { getSignedInUser } from "../auth/session.server.ts";
import { cloudflareContext } from "../context.ts";
import { GITHUB_SETUP_ERRORS, GITHUB_SETUP_FALLBACK } from "../github-messages.ts";
import { lastWorkspaceCookie } from "../workspaces.server.ts";
import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "ShareRepo" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await getSignedInUser(request, context);
  if (user === null) {
    const signInFailed = new URL(request.url).searchParams.has("error");
    return { user: null, workspaces: [], signInFailed, githubError: null };
  }
  // Back to the page that sent the visitor through sign-in, once; the cookie is cleared.
  const returnCookie = returnToCookie(context);
  const returnTo = safeReturnPath(
    await returnCookie.parse(request.headers.get("cookie")),
    context.get(cloudflareContext).env.auth.baseURL,
  );
  if (returnTo !== null) {
    throw redirect(returnTo, {
      headers: { "set-cookie": await returnCookie.serialize("", { maxAge: 0 }) },
    });
  }
  const services = servicesFor(context);
  const code = new URL(request.url).searchParams.get("github_error");
  const lastSlug: unknown = await lastWorkspaceCookie(context).parse(request.headers.get("cookie"));
  // A GitHub setup error is shown here, so stay instead of returning to the last workspace.
  if (code === null && typeof lastSlug === "string") {
    const reachable = await openWorkspace(services, user, lastSlug, "workspace.read").then(
      () => true,
      () => false,
    );
    if (reachable) throw redirect(`/w/${lastSlug}`);
  }
  const githubError = code === null ? null : (GITHUB_SETUP_ERRORS[code] ?? GITHUB_SETUP_FALLBACK);
  return {
    user,
    workspaces: await listMyWorkspaces(services, user),
    signInFailed: false,
    githubError,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { user, workspaces, signInFailed, githubError } = loaderData;
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">ShareRepo</h1>
      {user === null ? (
        <>
          <p className="mt-2 text-gray-600">Sell access to private repositories.</p>
          {signInFailed && (
            <p role="alert" className="mt-4 text-red-700">
              Sign-in failed. Please try again.
            </p>
          )}
          <Form method="post" action="/sign-in" className="mt-6">
            <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-white">
              Sign in with GitHub
            </button>
          </Form>
        </>
      ) : (
        <>
          <p className="mt-2 text-gray-600">Signed in as {user.name}.</p>
          {githubError !== null && (
            <p role="alert" className="mt-4 text-red-700">
              {githubError}
            </p>
          )}
          <Form method="post" action="/sign-out">
            <button type="submit" className="text-sm underline">
              Sign out
            </button>
          </Form>
          <h2 className="mt-8 text-lg font-semibold">Your workspaces</h2>
          {workspaces.length === 0 ? (
            <p className="mt-2 text-gray-600">You have no workspaces yet.</p>
          ) : (
            <ul className="mt-2 list-disc pl-6">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link to={`/w/${workspace.slug}`} className="underline">
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link to="/workspaces/new" className="mt-6 inline-block underline">
            Create a workspace
          </Link>
        </>
      )}
    </main>
  );
}
