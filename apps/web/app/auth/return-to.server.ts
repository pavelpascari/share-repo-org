import { createCookie, type RouterContextProvider } from "react-router";
import { cloudflareContext } from "../context.ts";

type Context = Readonly<RouterContextProvider>;

const MAX_RETURN_PATH = 512;

/**
 * Where to go after GitHub sign-in, when a signed-out visitor started it from a page that needs
 * sign-in (`/buy/…`, `/c/…/claim`, `/claim/<token>`). Kept in a short-lived, HTTP-only cookie in
 * the visitor's browser rather than in Better Auth's callback URL, which is stored in D1 with the
 * OAuth state: a claim path carries its token, and must not be persisted or logged.
 */
export function returnToCookie(context: Context) {
  const secure = context.get(cloudflareContext).env.auth.baseURL.startsWith("https:");
  return createCookie("sharerepo_return_to", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 10,
  });
}

// ASCII control characters, whitespace (URL parsers strip tabs and newlines) and backslashes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const UNSAFE_CHARACTERS = /[\u0000- \u007f\\]/;

/** A path a browser reads as same-origin: one leading slash, then no slash or backslash. */
const isPlainPath = (path: string) =>
  path.startsWith("/") && !path.startsWith("//") && !UNSAFE_CHARACTERS.test(path);

/**
 * A same-origin path to return to, or null. Only a plain absolute path is accepted, before and
 * after URL normalisation: not `//host`, not `/\host`, not `/.//host` (whose dot segment
 * normalises away), no control characters or whitespace, nothing that resolves to another origin,
 * and nothing longer than 512 characters.
 */
export function safeReturnPath(value: unknown, baseURL: string): string | null {
  if (typeof value !== "string" || value.length > MAX_RETURN_PATH) return null;
  if (!isPlainPath(value)) return null;
  // A plain path cannot change the origin; normalisation can still produce `//host`.
  const url = new URL(value, baseURL);
  const path = `${url.pathname}${url.search}`;
  return isPlainPath(path) ? path : null;
}
