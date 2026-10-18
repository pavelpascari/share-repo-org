import { data } from "react-router";

/**
 * CSRF defence for our own form actions (Better Auth protects only its own routes). A
 * state-changing request must come from our origin: `Origin` must match when present, and
 * otherwise the browser's `Sec-Fetch-Site` must say same-origin. Requests with neither are refused.
 */
export function isSameOrigin(request: Request, baseURL: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(baseURL).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** Throws a 403 response unless the request is same-origin. */
export function assertSameOrigin(request: Request, baseURL: string): void {
  if (!isSameOrigin(request, baseURL)) {
    throw data({ message: "Cross-origin request refused." }, { status: 403 });
  }
}
