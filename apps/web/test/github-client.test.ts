import { withSecretCanaries } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  createGitHubClient,
  GITHUB_ENDPOINTS,
  GitHubAuthError,
  type GitHubAuthErrorKind,
  type GitHubEndpoints,
} from "../app/auth/github.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A fetch double that records calls and answers with the given responses in order. */
function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.method === "GET" ? null : await request.text(),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const E2E_ENDPOINTS: GitHubEndpoints = {
  authorizeUrl: "http://localhost:5190/login/oauth/authorize",
  tokenUrl: "http://localhost:5190/login/oauth/access_token",
  apiBaseUrl: "http://localhost:5190/api",
};

function client(fetch: typeof globalThis.fetch, secrets = { clientSecret: "client-secret" }) {
  return createGitHubClient({
    endpoints: E2E_ENDPOINTS,
    clientId: "client-id",
    clientSecret: secrets.clientSecret,
    fetch,
  });
}

async function failure(promise: Promise<unknown>): Promise<GitHubAuthError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a GitHubAuthError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GitHubAuthError);
  return error as GitHubAuthError;
}

const exchange = {
  code: "the-code",
  redirectURI: "http://localhost:5180/api/auth/callback/github",
};

describe("GITHUB_ENDPOINTS", () => {
  it("points at github.com and cannot be mutated", () => {
    expect(GITHUB_ENDPOINTS).toEqual({
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      apiBaseUrl: "https://api.github.com",
    });
    expect(Object.isFrozen(GITHUB_ENDPOINTS)).toBe(true);
  });
});

describe("createGitHubClient", () => {
  it("exposes its endpoints and client ID for the OAuth plugin", () => {
    const github = client(fakeFetch().fetch);
    expect(github.endpoints).toBe(E2E_ENDPOINTS);
    expect(github.clientId).toBe("client-id");
  });
});

describe("exchangeCode", () => {
  it("posts the code, client credentials, redirect URI and PKCE verifier", async () => {
    const { fetch, calls } = fakeFetch(json({ access_token: "tok", token_type: "bearer" }));
    await expect(
      client(fetch).exchangeCode({ ...exchange, codeVerifier: "verifier" }),
    ).resolves.toEqual({ accessToken: "tok" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(E2E_ENDPOINTS.tokenUrl);
    expect(call?.method).toBe("POST");
    expect(call?.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "ShareRepo",
    });
    expect(Object.fromEntries(new URLSearchParams(call?.body ?? ""))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "the-code",
      redirect_uri: exchange.redirectURI,
      code_verifier: "verifier",
    });
  });

  it("omits code_verifier when there is none", async () => {
    const { fetch, calls } = fakeFetch(json({ access_token: "tok" }));
    await client(fetch).exchangeCode({ ...exchange, codeVerifier: undefined });
    expect(new URLSearchParams(calls[0]?.body ?? "").has("code_verifier")).toBe(false);
  });

  it.each<[string, Response | Error, GitHubAuthErrorKind]>([
    [
      "a bad code (200 with error)",
      json({ error: "bad_verification_code" }),
      "bad_verification_code",
    ],
    ["bad client credentials", json({ error: "incorrect_client_credentials" }), "rejected"],
    ["a redirect URI mismatch", json({ error: "redirect_uri_mismatch" }), "rejected"],
    ["a 4xx status", json({ message: "Not Found" }, 404), "rejected"],
    ["a 5xx status", new Response("oops", { status: 502 }), "upstream_unavailable"],
    ["a 429 status", new Response("slow down", { status: 429 }), "upstream_unavailable"],
    ["a network failure", new TypeError("fetch failed"), "upstream_unavailable"],
    ["invalid JSON", new Response("<html>", { status: 200 }), "malformed_response"],
    ["a body without a token", json({ token_type: "bearer" }), "malformed_response"],
    ["an empty token", json({ access_token: "" }), "malformed_response"],
    ["an empty error", json({ error: "" }), "malformed_response"],
    ["a non-object body", json(["access_token"]), "malformed_response"],
  ])("classifies %s", async (_, response, kind) => {
    const error = await failure(client(fakeFetch(response).fetch).exchangeCode(exchange));
    expect(error.kind).toBe(kind);
    expect(error.name).toBe("GitHubAuthError");
    expect(error.cause).toBeUndefined();
  });

  it("names the status in the error message", async () => {
    const error = await failure(
      client(fakeFetch(new Response(null, { status: 503 })).fetch).exchangeCode(exchange),
    );
    expect(error.message).toBe("GitHub token exchange returned 503");
  });
});

describe("getUser", () => {
  const profile = {
    id: 583231,
    login: "octocat",
    name: "The Octocat",
    avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
    email: "octocat@github.com",
  };

  it("reads /user with the token and API headers, returning the immutable ID as a string", async () => {
    const { fetch, calls } = fakeFetch(json(profile));
    await expect(client(fetch).getUser("tok")).resolves.toEqual({
      id: "583231",
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    });
    expect(calls[0]?.url).toBe("http://localhost:5190/api/user");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      authorization: "Bearer tok",
      "user-agent": "ShareRepo",
      "x-github-api-version": "2022-11-28",
    });
  });

  it("never returns the email GitHub sends", async () => {
    const user = await client(fakeFetch(json(profile)).fetch).getUser("tok");
    expect(JSON.stringify(user)).not.toContain("octocat@github.com");
  });

  it.each([
    [
      { name: null, avatar_url: null },
      { name: null, avatarUrl: null },
    ],
    [
      { name: "", avatar_url: undefined },
      { name: null, avatarUrl: null },
    ],
  ])("normalises missing optional fields (%j)", async (fields, expected) => {
    const user = await client(fakeFetch(json({ ...profile, ...fields })).fetch).getUser("tok");
    expect(user).toMatchObject(expected);
  });

  it.each<[string, Response | Error, GitHubAuthErrorKind]>([
    ["a revoked token (401)", json({ message: "Bad credentials" }, 401), "rejected"],
    ["a 5xx status", new Response(null, { status: 500 }), "upstream_unavailable"],
    ["a network failure", new TypeError("fetch failed"), "upstream_unavailable"],
    ["invalid JSON", new Response("not json"), "malformed_response"],
    ["a string ID", json({ ...profile, id: "583231" }), "malformed_response"],
    ["a zero ID", json({ ...profile, id: 0 }), "malformed_response"],
    ["a fractional ID", json({ ...profile, id: 1.5 }), "malformed_response"],
    ["an unsafe integer ID", json({ ...profile, id: 2 ** 53 }), "malformed_response"],
    ["an empty login", json({ ...profile, login: "" }), "malformed_response"],
    ["a 40-character login", json({ ...profile, login: "a".repeat(40) }), "malformed_response"],
    ["a non-URL avatar", json({ ...profile, avatar_url: "nope" }), "malformed_response"],
  ])("classifies %s", async (_, response, kind) => {
    const error = await failure(client(fakeFetch(response).fetch).getUser("tok"));
    expect(error.kind).toBe(kind);
  });

  it("accepts a 39-character login", async () => {
    const login = "a".repeat(39);
    const user = await client(fakeFetch(json({ ...profile, login })).fetch).getUser("tok");
    expect(user.login).toBe(login);
  });
});

describe("secret handling", () => {
  it("never puts the code, client secret or access token into errors or logs", async () => {
    await withSecretCanaries(["code", "clientSecret", "accessToken"], async (canaries) => {
      const failures: unknown[] = [];
      // Every failure path, with each secret echoed back in the response where GitHub could.
      const echo = `${canaries.code} ${canaries.clientSecret} ${canaries.accessToken}`;
      const responses: Array<() => Response | Error> = [
        () => new TypeError(`fetch failed: ${echo}`),
        () => new Response(echo, { status: 500 }),
        () => new Response(echo, { status: 400 }),
        () => new Response(`{"access_token": "${echo}`, { status: 200 }),
        () => json({ error: "bad_verification_code", error_description: echo }),
        () => json({ error: echo }),
        () => json({ access_token: 42, echo }),
      ];
      for (const response of responses) {
        const github = client(fakeFetch(response()).fetch, {
          clientSecret: canaries.clientSecret,
        });
        failures.push(await failure(github.exchangeCode({ ...exchange, code: canaries.code })));
        failures.push(
          await failure(client(fakeFetch(response()).fetch).getUser(canaries.accessToken)),
        );
      }
      return failures;
    });
  });
});
