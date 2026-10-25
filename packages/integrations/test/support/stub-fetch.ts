/** A recorded request, with the Authorization header kept so tests can check token use. */
export interface StubCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

export type StubRoute = (request: {
  method: string;
  url: URL;
  body: string | null;
}) => Response | Promise<Response> | undefined;

export const API = "https://api.github.test";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A `fetch` that answers from routes in order and records every call. Unmatched → 404. */
export function stubFetch(routes: StubRoute[]) {
  const calls: StubCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url: url.toString(), authorization: headers.get("authorization"), body });
    for (const route of routes) {
      const response = await route({ method, url, body });
      if (response !== undefined) return response;
    }
    return jsonResponse(404, { message: "Not Found" });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Matches method and path (ignoring the query) and returns the response. */
export function on(method: string, path: string, respond: () => Response): StubRoute {
  return (request) =>
    request.method === method && request.url.pathname === path ? respond() : undefined;
}

/** The installation-token route every installation call needs. */
export function tokenRoute(installationId: string, expiresAt = "2099-01-01T00:00:00Z") {
  return on("POST", `/app/installations/${installationId}/access_tokens`, () =>
    jsonResponse(201, { token: `ghs_token_${installationId}`, expires_at: expiresAt }),
  );
}

/**
 * A `fetch` that hangs as a stalled server would, until the request's own signal aborts it:
 * at `headers`, no response ever arrives; at `body`, the 200 headers and the first bytes arrive,
 * then the body stalls. Like the real `fetch`, aborting the signal rejects the pending promise,
 * or errors the body stream, with the signal's reason. A request without a signal hangs for ever,
 * which is the bug this exists to catch.
 */
export function hangingFetch(stage: "headers" | "body") {
  const signals: AbortSignal[] = [];
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal) signals.push(signal);
    if (stage === "headers") {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, signals };
}
