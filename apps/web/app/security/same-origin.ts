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

/**
 * Whether the browser says another site started this request (`Sec-Fetch-Site` is `cross-site` or
 * `same-site`). A GET whose loader writes, such as an operator's audited workspace view, refuses
 * such a request, so another site cannot make an operator's browser write that record. A typed
 * URL (`none`), our own links (`same-origin`) and clients that send no header are not refused.
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}
