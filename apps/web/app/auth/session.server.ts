import { recordSignOut } from "@sharerepo/application";
import { type RouterContextProvider, redirect } from "react-router";
import { cloudflareContext } from "../context.ts";
import {
  AUTH_BASE_PATH,
  CLIENT_IP_HEADER,
  GITHUB_PROVIDER_ID,
  SIGN_IN_ERROR_PATH,
} from "./auth.ts";
import { authFor, servicesFor } from "./server.ts";

type Context = Readonly<RouterContextProvider>;

export interface SignedInUser {
  readonly userId: string;
  readonly name: string;
  readonly image: string | null;
  /** When this session was created (the sign-in through GitHub), epoch milliseconds. */
  readonly sessionCreatedAt: number;
}

/** The signed-in user, or null. Sessions are checked against D1 on every request. */
export async function getSignedInUser(request: Request, context: Context) {
  const session = await authFor(context).api.getSession({ headers: request.headers });
  if (session === null) return null;
  const { id, name, image } = session.user;
  return {
    userId: id,
    name,
    image: image ?? null,
    sessionCreatedAt: new Date(session.session.createdAt).getTime(),
  } satisfies SignedInUser;
}

/** The signed-in user; otherwise redirects to the home page, which offers sign-in. */
export async function requireUser(request: Request, context: Context): Promise<SignedInUser> {
  const user = await getSignedInUser(request, context);
  if (user === null) throw redirect("/");
  return user;
}

/**
 * Starts GitHub sign-in through Better Auth's handler (not its server API), so the per-IP rate
 * limit applies, and redirects the browser to GitHub with Better Auth's state cookies.
 */
export async function startGitHubSignIn(request: Request, context: Context): Promise<Response> {
  const auth = authFor(context);
  const { baseURL } = context.get(cloudflareContext).env.auth;
  const headers = new Headers({
    "content-type": "application/json",
    origin: new URL(baseURL).origin,
  });
  const clientIp = request.headers.get(CLIENT_IP_HEADER);
  if (clientIp !== null) headers.set(CLIENT_IP_HEADER, clientIp);

  const response = await auth.handler(
    new Request(`${baseURL}${AUTH_BASE_PATH}/sign-in/social`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: GITHUB_PROVIDER_ID,
        callbackURL: "/",
        errorCallbackURL: SIGN_IN_ERROR_PATH,
      }),
    }),
  );
  if (!response.ok) return response;
  const { url } = (await response.json()) as { url: string };
  return redirect(url, { headers: setCookiesFrom(response) });
}

/** Ends the session, then records the sign-out, and returns to the home page. */
export async function signOut(request: Request, context: Context): Promise<Response> {
  const user = await getSignedInUser(request, context);
  const response = await authFor(context).api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  // Audit only once the session is gone, so the trail never shows a sign-out that did not happen.
  if (user !== null && response.ok) await recordSignOut(servicesFor(context), user);
  return redirect("/", { headers: setCookiesFrom(response) });
}

function setCookiesFrom(response: Response): Headers {
  const headers = new Headers();
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}
