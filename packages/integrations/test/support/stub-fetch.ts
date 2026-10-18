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
