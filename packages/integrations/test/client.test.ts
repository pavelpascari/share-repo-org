import { createSecretCanaries, expectNoCanaryLeak, FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { nextLink, pathSegment } from "../src/github/client.ts";
import { createGitHubApp, GitHubApiError } from "../src/index.ts";
import installation from "./fixtures/installation.json";
import { appKey } from "./support/keys.ts";
import {
  API,
  jsonResponse,
  on,
  type StubRoute,
  stubFetch,
  tokenRoute,
} from "./support/stub-fetch.ts";

const NOW = "2026-10-18T12:00:00Z";

async function client(routes: StubRoute[], clock = new FakeClock(NOW)) {
  const stub = stubFetch(routes);
  const app = createGitHubApp({
    appId: "1000",
    privateKeyPem: (await appKey()).pem,
    apiBaseUrl: API,
    fetch: stub.fetch,
    clock,
    install: { slug: "sharerepo-dev", webBaseUrl: "https://github.test" },
  });
  return { app, calls: stub.calls, clock };
}

async function failure(promise: Promise<unknown>): Promise<GitHubApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubApiError);
  return error as GitHubApiError;
}

describe("requests", () => {
  it("sends GitHub's headers with the App JWT for App endpoints", async () => {
    const { app, calls } = await client([
      on("GET", "/app/installations/42", () => jsonResponse(200, installation)),
    ]);
    await app.getInstallation("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("checks the headers GitHub requires", async () => {
    let seen: Headers | undefined;
    const app = createGitHubApp({
      appId: "1000",
      privateKeyPem: (await appKey()).pem,
      apiBaseUrl: API,
      clock: new FakeClock(NOW),
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return jsonResponse(200, installation);
      }) as typeof fetch,
    });
    await app.getInstallation("42");
    expect(Object.fromEntries(seen?.entries() ?? [])).toMatchObject({
      accept: "application/vnd.github+json",
      "user-agent": "ShareRepo",
      "x-github-api-version": "2022-11-28",
    });
  });

  it("maps an organization and an enterprise account type", async () => {
    const { app } = await client([
      on("GET", "/app/installations/1", () =>
        jsonResponse(200, {
          ...installation,
          account: { id: 9, login: "acme", type: "Organization" },
        }),
      ),
      on("GET", "/app/installations/2", () =>
        jsonResponse(200, { ...installation, account: { id: 9, login: "acme-ent" } }),
      ),
    ]);
    expect((await app.getInstallation("1")).account.type).toBe("Organization");
    expect((await app.getInstallation("2")).account.type).toBe("Enterprise");
  });
});

describe("installation tokens", () => {
  it("mints a token once and reuses it until 5 minutes before expiry", async () => {
    const { app, calls, clock } = await client([tokenRoute("42", "2026-10-18T13:00:00Z")]);
    expect(await app.installationToken("42")).toBe("ghs_token_42");
    clock.set("2026-10-18T12:54:59Z");
    await app.installationToken("42");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    clock.set("2026-10-18T12:55:00Z");
    await app.installationToken("42");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${API}/app/installations/42/access_tokens`);
  });

  it("uses the installation token for repository endpoints", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("GET", "/installation/repositories", () => jsonResponse(200, { repositories: [] })),
    ]);
    await app.listInstallationRepositories("42");
    expect(calls.at(-1)?.authorization).toBe("Bearer ghs_token_42");
  });

  it("rejects a malformed token response", async () => {
    const { app } = await client([
      on("POST", "/app/installations/42/access_tokens", () => jsonResponse(201, { token: "" })),
    ]);
    expect((await failure(app.installationToken("42"))).kind).toBe("malformed_response");
  });
});

describe("pagination", () => {
  it("stops when there is no next link", async () => {
    expect(nextLink(null, API)).toBeNull();
    expect(nextLink(`<${API}/x?page=1>; rel="prev"`, API)).toBeNull();
    expect(nextLink(`<${API}/x?page=2>; rel="next"`, API)).toBe(`${API}/x?page=2`);
    expect(nextLink(`<${API}/x?page=2>; rel="next last"`, API)).toBe(`${API}/x?page=2`);
    expect(nextLink("garbage", API)).toBeNull();
  });

  it("never follows a next link to another origin (it would leak the token)", () => {
    expect(nextLink(`<https://evil.example/x>; rel="next"`, API)).toBeNull();
    expect(nextLink(`<${API}.evil.example/x>; rel="next"`, API)).toBeNull();
  });

  it("gives up after 50 pages", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("GET", "/installation/repositories", () =>
        jsonResponse(
          200,
          { repositories: [] },
          { link: `<${API}/installation/repositories?page=n>; rel="next"` },
        ),
      ),
    ]);
    const error = await failure(app.listInstallationRepositories("42"));
    expect(error).toMatchObject({
      kind: "malformed_response",
      message: expect.stringContaining("too many pages"),
    });
  });
});

describe("error classification", () => {
  const getting = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    client([on("GET", "/app/installations/42", () => jsonResponse(status, body, headers))]).then(
      ({ app }) => failure(app.getInstallation("42")),
    );

  it.each([
    [404, {}, {}, "not_found"],
    [403, { message: "This installation has been suspended" }, {}, "suspended"],
    [403, { message: "Resource not accessible by integration" }, {}, "rejected"],
    [401, { message: "Bad credentials" }, {}, "rejected"],
    [500, {}, {}, "transient"],
    [503, "not json", {}, "transient"],
    [429, {}, {}, "rate_limited"],
    [403, {}, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [403, {}, { "retry-after": "30" }, "rate_limited"],
  ] as const)("%i %j %j → %s", async (status, body, headers, kind) => {
    const error = await getting(status, body, headers);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.message).toBe(`GitHub get installation failed with status ${status}`);
  });

  it("classifies a 403 without a message as rejected", async () => {
    expect((await getting(403, {})).kind).toBe("rejected");
  });

  it("classifies an error with a non-JSON body", async () => {
    const { app } = await client([
      on("GET", "/app/installations/42", () => new Response("<html>bad gateway", { status: 502 })),
    ]);
    expect((await failure(app.getInstallation("42"))).kind).toBe("transient");
  });

  it("derives the retry delay from retry-after, then x-ratelimit-reset, then a default", async () => {
    expect((await getting(429, {}, { "retry-after": "30" })).retryAfterMs).toBe(30_000);
    const reset = String(Date.parse(NOW) / 1000 + 90);
    expect((await getting(429, {}, { "x-ratelimit-reset": reset })).retryAfterMs).toBe(90_000);
    const past = String(Date.parse(NOW) / 1000 - 10);
    expect((await getting(429, {}, { "x-ratelimit-reset": past })).retryAfterMs).toBe(0);
    expect((await getting(429, {}, { "retry-after": "soon" })).retryAfterMs).toBe(60_000);
    expect((await getting(429, {})).retryAfterMs).toBe(60_000);
  });

  it("keeps GitHub's 422 error codes, never its messages", async () => {
    const error = await getting(422, {
      message: "Validation Failed",
      errors: [{ resource: "Repository", code: "custom", message: "secret detail" }],
    });
    expect(error.kind).toBe("rejected");
    expect(error.githubErrorCodes).toEqual(["custom"]);
    expect(JSON.stringify(error)).not.toContain("secret detail");
  });

  it("classifies network failures as transient", async () => {
    const app = createGitHubApp({
      appId: "1000",
      privateKeyPem: (await appKey()).pem,
      apiBaseUrl: API,
      clock: new FakeClock(NOW),
      fetch: (async () => {
        throw new TypeError("connection reset");
      }) as typeof fetch,
    });
    const error = await failure(app.getInstallation("42"));
    expect(error).toMatchObject({
      kind: "transient",
      message: "GitHub get installation failed: network error",
    });
  });

  it("classifies a malformed 200 body", async () => {
    const { app } = await client([
      on("GET", "/app/installations/42", () => jsonResponse(200, { id: "x" })),
    ]);
    expect((await failure(app.getInstallation("42"))).kind).toBe("malformed_response");
  });

  it("never puts tokens, the JWT or response bodies into errors", async () => {
    const canaries = createSecretCanaries(["token", "body"]);
    const { app, calls } = await client([
      on("POST", "/app/installations/42/access_tokens", () =>
        jsonResponse(201, { token: canaries.token, expires_at: "2099-01-01T00:00:00Z" }),
      ),
      on("GET", "/installation/repositories", () =>
        jsonResponse(422, { message: canaries.body, errors: [{ code: "invalid" }] }),
      ),
    ]);
    const error = await failure(app.listInstallationRepositories("42"));
    expectNoCanaryLeak(error, canaries);
    const jwt = calls[0]?.authorization?.replace("Bearer ", "") ?? "";
    expect(JSON.stringify(error) + error.message + String(error.stack)).not.toContain(jwt);
  });
});

describe("collaborators and invitations", () => {
  const repoPath = "/repos/octo-creator/course-code";

  it("lists collaborators and invitations with IDs as strings", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("GET", `${repoPath}/collaborators`, () =>
        jsonResponse(200, [{ id: 5001, login: "octo-creator", type: "User" }]),
      ),
      on("GET", `${repoPath}/invitations`, () =>
        jsonResponse(200, [
          {
            id: 77,
            invitee: { id: 6001, login: "subscriber" },
            permissions: "write",
            expired: false,
            created_at: "2026-10-18T10:00:00Z",
          },
          {
            id: 78,
            invitee: null,
            permissions: "write",
            expired: true,
            created_at: "2026-10-01T10:00:00Z",
          },
        ]),
      ),
    ]);
    expect(await app.listCollaborators("42", "octo-creator", "course-code")).toEqual([
      { id: "5001", login: "octo-creator" },
    ]);
    expect(await app.listInvitations("42", "octo-creator", "course-code")).toEqual([
      {
        id: "77",
        invitee: { id: "6001", login: "subscriber" },
        permissions: "write",
        expired: false,
        createdAt: Date.parse("2026-10-18T10:00:00Z"),
      },
      {
        id: "78",
        invitee: null,
        permissions: "write",
        expired: true,
        createdAt: Date.parse("2026-10-01T10:00:00Z"),
      },
    ]);
    expect(calls.find((call) => call.url.includes("/collaborators"))?.url).toBe(
      `${API}${repoPath}/collaborators?affiliation=direct&per_page=100`,
    );
  });

  it("adds a collaborator: 201 is a pending invitation, 204 already a collaborator", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("PUT", `${repoPath}/collaborators/subscriber`, () => jsonResponse(201, { id: 77 })),
      on("PUT", `${repoPath}/collaborators/member`, () => new Response(null, { status: 204 })),
    ]);
    expect(
      await app.addCollaborator("42", "octo-creator", "course-code", "subscriber", "pull"),
    ).toEqual({
      status: 201,
      invitationId: "77",
    });
    expect(calls.at(-1)?.body).toBe('{"permission":"pull"}');
    expect(await app.addCollaborator("42", "octo-creator", "course-code", "member")).toEqual({
      status: 204,
    });
    expect(calls.at(-1)?.body).toBe("{}");
  });

  it("treats an unexpected success status from PUT as malformed", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("PUT", `${repoPath}/collaborators/odd`, () => jsonResponse(200, {})),
    ]);
    expect(
      (await failure(app.addCollaborator("42", "octo-creator", "course-code", "odd"))).kind,
    ).toBe("malformed_response");
  });

  it("removes collaborators and deletes invitations, escaping path segments", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on(
        "DELETE",
        `${repoPath}/collaborators/subscriber`,
        () => new Response(null, { status: 204 }),
      ),
      on("DELETE", `${repoPath}/invitations/77`, () => new Response(null, { status: 204 })),
    ]);
    expect(await app.removeCollaborator("42", "octo-creator", "course-code", "subscriber")).toBe(
      204,
    );
    expect(await app.deleteInvitation("42", "octo-creator", "course-code", "77")).toBe(204);
    const sent = calls.length;
    for (const username of ["..", ".", "../../x", "a/b", ""]) {
      const error = await failure(
        app.removeCollaborator("42", "octo-creator", "course-code", username),
      );
      expect(error.kind).toBe("rejected");
    }
    await failure(app.removeCollaborator("42", "octo-creator", "..", "subscriber"));
    await failure(app.deleteInvitation("42", "octo-creator", "course-code", ".."));
    await failure(app.getInstallation("../42"));
    // Refused before any request: `DELETE /repos/o/r/collaborators/..` would resolve to
    // `DELETE /repos/o/r` and delete the repository.
    expect(calls.length).toBe(sent);
  });
});

describe("getUserByLogin", () => {
  it("looks the login up with the installation token and maps the account type", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("GET", "/users/octo-bot", () =>
        jsonResponse(200, { id: 7001, login: "octo-bot", type: "Bot" }),
      ),
      on("GET", "/users/acme", () =>
        jsonResponse(200, { id: 7002, login: "acme", type: "Organization" }),
      ),
    ]);
    expect(await app.getUserByLogin("42", "octo-bot")).toEqual({
      id: "7001",
      login: "octo-bot",
      type: "Bot",
    });
    expect((await app.getUserByLogin("42", "acme")).type).toBe("Organization");
    expect(calls.map((call) => [call.method, call.url, call.authorization])).toEqual([
      ["POST", `${API}/app/installations/42/access_tokens`, expect.stringMatching(/^Bearer /)],
      ["GET", `${API}/users/octo-bot`, "Bearer ghs_token_42"],
      ["GET", `${API}/users/acme`, "Bearer ghs_token_42"],
    ]);
  });

  it("validates the login before making any request", async () => {
    const { app, calls } = await client([tokenRoute("42")]);
    for (const login of ["..", "octo/../x", "a b", "", "x".repeat(40)]) {
      const error = await failure(app.getUserByLogin("42", login));
      expect(error.kind).toBe("rejected");
      expect(error.message).toBe("GitHub request refused: invalid login");
    }
    expect(calls).toEqual([]);
  });

  it("rejects a user response with a bad ID or an unknown type", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("GET", "/users/zero", () => jsonResponse(200, { id: 0, login: "zero", type: "User" })),
      on("GET", "/users/odd", () => jsonResponse(200, { id: 1, login: "odd", type: "Mannequin" })),
    ]);
    expect((await failure(app.getUserByLogin("42", "zero"))).kind).toBe("malformed_response");
    expect((await failure(app.getUserByLogin("42", "odd"))).kind).toBe("malformed_response");
  });

  it("never puts the installation token into a lookup error", async () => {
    const canaries = createSecretCanaries(["token"]);
    const { app } = await client([
      on("POST", "/app/installations/42/access_tokens", () =>
        jsonResponse(201, { token: canaries.token, expires_at: "2099-01-01T00:00:00Z" }),
      ),
    ]);
    const error = await failure(app.getUserByLogin("42", "missing"));
    expect(error).toMatchObject({ kind: "not_found", status: 404 });
    expectNoCanaryLeak(error, canaries);
  });
});

describe("pathSegment", () => {
  it.each([
    ["login", "octo-creator", true],
    ["login", "a".repeat(39), true],
    ["login", "a".repeat(40), false],
    ["login", "..", false],
    ["login", "octo_creator", false],
    ["repo", "course-code.v2", true],
    ["repo", ".github", true],
    ["repo", ".", false],
    ["repo", "..", false],
    ["repo", "a/b", false],
    ["repo", "a".repeat(101), false],
    ["id", "77", true],
    ["id", "077", false],
    ["id", "-1", false],
    ["id", "1".repeat(21), false],
  ] as const)("%s %j → %s", (kind, value, valid) => {
    if (valid) expect(pathSegment(kind, value)).toBe(value);
    else expect(() => pathSegment(kind, value)).toThrow(`invalid ${kind} path segment`);
  });
});

describe("installUrl", () => {
  it("sends the user to the App's install page with the state", async () => {
    const { app } = await client([]);
    expect(app.installUrl("tok en")).toBe(
      "https://github.test/apps/sharerepo-dev/installations/new?state=tok+en",
    );
  });

  it("needs the slug", async () => {
    const app = createGitHubApp({
      appId: "1000",
      privateKeyPem: (await appKey()).pem,
      apiBaseUrl: API,
      fetch: stubFetch([]).fetch,
      clock: new FakeClock(NOW),
    });
    expect(() => app.installUrl("x")).toThrow("GitHub App slug is not configured");
  });
});
