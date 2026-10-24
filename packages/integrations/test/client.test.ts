import { createSecretCanaries, expectNoCanaryLeak, FakeClock } from "@sharerepo/testing";
import { describe, expect, it, vi } from "vitest";
import { nextLink, pathSegment } from "../src/github/client.ts";
import { createGitHubApp, GitHubApiError, REQUEST_TIMEOUT_MS } from "../src/index.ts";
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

  it("refuses a next link to another origin (it would leak the token) as malformed", () => {
    for (const url of ["https://evil.example/x", `${API}.evil.example/x`, API]) {
      expect(() => nextLink(`<${url}>; rel="next"`, API)).toThrow(
        expect.objectContaining({ kind: "malformed_response" }),
      );
    }
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

  it("gives every request a timeout, and classifies one that timed out as transient", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const app = createGitHubApp({
      appId: "1000",
      privateKeyPem: (await appKey()).pem,
      apiBaseUrl: API,
      clock: new FakeClock(NOW),
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal);
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof fetch,
    });
    expect(REQUEST_TIMEOUT_MS).toBe(20_000);
    const error = await failure(app.getInstallation("42"));
    expect(error).toMatchObject({
      kind: "transient",
      message: "GitHub get installation failed: network error",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("aborts each request after REQUEST_TIMEOUT_MS", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const signals: (AbortSignal | null | undefined)[] = [];
      const app = createGitHubApp({
        appId: "1000",
        privateKeyPem: (await appKey()).pem,
        apiBaseUrl: API,
        clock: new FakeClock(NOW),
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          signals.push(init?.signal);
          return jsonResponse(200, installation);
        }) as typeof fetch,
      });
      await app.getInstallation("42");
      expect(timeout.mock.calls).toEqual([[REQUEST_TIMEOUT_MS]]);
      expect(signals).toEqual([timeout.mock.results[0]?.value]);
    } finally {
      timeout.mockRestore();
    }
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
  const REPO = "octo-creator/course-code";
  const repoPath = `/repos/${REPO}`;
  const noContent = () => new Response(null, { status: 204 });
  const collaborator = (permissions: Record<string, boolean>) => ({
    id: 6001,
    login: "octo-subscriber",
    permissions,
  });

  it("asks for the affiliation, 100 per page, with the installation token", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("GET", `${repoPath}/collaborators`, () => jsonResponse(200, [])),
      on("GET", `${repoPath}/invitations`, () => jsonResponse(200, [])),
    ]);
    await app.listCollaborators("42", REPO, "all");
    await app.listCollaborators("42", REPO, "direct");
    await app.listInvitations("42", REPO);
    expect(calls.slice(1).map((call) => [call.method, call.url, call.authorization])).toEqual([
      [
        "GET",
        `${API}${repoPath}/collaborators?affiliation=all&per_page=100`,
        "Bearer ghs_token_42",
      ],
      [
        "GET",
        `${API}${repoPath}/collaborators?affiliation=direct&per_page=100`,
        "Bearer ghs_token_42",
      ],
      ["GET", `${API}${repoPath}/invitations?per_page=100`, "Bearer ghs_token_42"],
    ]);
  });

  it.each([
    [{ admin: true, maintain: true, push: true, triage: true, pull: true }, "admin"],
    [{ admin: false, maintain: true, push: false, triage: true, pull: true }, "write"],
    [{ admin: false, push: true, pull: true }, "write"],
    [{ admin: false, maintain: false, push: false, triage: true, pull: true }, "read"],
    [{ admin: false, push: false, pull: true }, "read"],
  ])("maps permissions %j to %s", async (permissions, permission) => {
    const { app } = await client([
      tokenRoute("42"),
      on("GET", `${repoPath}/collaborators`, () => jsonResponse(200, [collaborator(permissions)])),
    ]);
    expect(await app.listCollaborators("42", REPO, "direct")).toEqual([
      { id: "6001", login: "octo-subscriber", permission },
    ]);
  });

  it("rejects a collaborator without a permissions object", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("GET", `${repoPath}/collaborators`, () =>
        jsonResponse(200, [{ id: 6001, login: "octo-subscriber" }]),
      ),
    ]);
    expect((await failure(app.listCollaborators("42", REPO, "direct"))).kind).toBe(
      "malformed_response",
    );
  });

  it("treats an invitation without an expired flag as not expired", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("GET", `${repoPath}/invitations`, () =>
        jsonResponse(200, [
          {
            id: 77,
            invitee: { id: 6001, login: "octo-subscriber" },
            created_at: "2026-10-18T10:00:00Z",
          },
        ]),
      ),
    ]);
    expect(await app.listInvitations("42", REPO)).toEqual([
      {
        id: "77",
        inviteeId: "6001",
        inviteeLogin: "octo-subscriber",
        createdAt: Date.parse("2026-10-18T10:00:00Z"),
        expired: false,
      },
    ]);
  });

  it("gives up after 30 pages of collaborators or invitations, never truncating", async () => {
    const endless = (path: string) =>
      on("GET", path, () => jsonResponse(200, [], { link: `<${API}${path}?page=n>; rel="next"` }));
    const { app, calls } = await client([
      tokenRoute("42"),
      endless(`${repoPath}/collaborators`),
      endless(`${repoPath}/invitations`),
    ]);
    const error = await failure(app.listCollaborators("42", REPO, "direct"));
    expect(error).toMatchObject({
      kind: "malformed_response",
      message: "GitHub list collaborators: too many pages",
    });
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(30);
    expect((await failure(app.listInvitations("42", REPO))).kind).toBe("malformed_response");
  });

  it("refuses a next link outside the API as malformed, without following it", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("GET", `${repoPath}/invitations`, () =>
        jsonResponse(200, [], {
          link: `<https://evil.example${repoPath}/invitations?page=2>; rel="next"`,
        }),
      ),
    ]);
    const error = await failure(app.listInvitations("42", REPO));
    expect(error).toMatchObject({
      kind: "malformed_response",
      message: "GitHub pagination link points outside the API",
    });
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      new URL(API).host,
      new URL(API).host,
    ]);
  });

  it("validates the repository, login, invitation ID and affiliation before any request", async () => {
    const { app, calls } = await client([tokenRoute("42")]);
    const refused = [
      ["invalid repository", app.listInvitations("42", "course-code")],
      ["invalid repository", app.listInvitations("42", "a/b/c")],
      ["invalid login path segment", app.listInvitations("42", "../course-code")],
      ["invalid repo path segment", app.listInvitations("42", "octo-creator/..")],
      ["invalid login", app.addCollaborator("42", REPO, "..")],
      ["invalid login", app.removeCollaborator("42", REPO, "octo/../x")],
      ["invalid id path segment", app.cancelInvitation("42", REPO, "..")],
      ["invalid id path segment", app.getUserById("42", "0")],
      ["invalid affiliation", app.listCollaborators("42", REPO, "outside" as unknown as "direct")],
    ] as const;
    for (const [reason, call] of refused) {
      const error = await failure(call);
      expect(error).toMatchObject({
        kind: "rejected",
        message: `GitHub request refused: ${reason}`,
      });
    }
    expect(calls).toEqual([]);
  });

  it("invites without a permission and reads the invitation from a 201", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("PUT", `${repoPath}/collaborators/octo-subscriber`, () =>
        jsonResponse(201, { id: 77, created_at: "2026-10-18T10:00:00Z" }),
      ),
      on("PUT", `${repoPath}/collaborators/octo-member`, noContent),
    ]);
    expect(await app.addCollaborator("42", REPO, "octo-subscriber")).toEqual({
      outcome: "invited",
      invitationId: "77",
      createdAt: Date.parse("2026-10-18T10:00:00Z"),
    });
    expect(calls.at(-1)?.body).toBe("{}");
    expect(await app.addCollaborator("42", REPO, "octo-member")).toEqual({
      outcome: "already_collaborator",
    });
  });

  it("treats an unexpected PUT status or 201 body as malformed", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("PUT", `${repoPath}/collaborators/odd`, () => jsonResponse(200, {})),
      on("PUT", `${repoPath}/collaborators/bodyless`, () => jsonResponse(201, { id: 77 })),
    ]);
    expect(await failure(app.addCollaborator("42", REPO, "odd"))).toMatchObject({
      kind: "malformed_response",
      status: 200,
    });
    expect((await failure(app.addCollaborator("42", REPO, "bodyless"))).kind).toBe(
      "malformed_response",
    );
  });

  it("removes collaborators and cancels invitations", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("DELETE", `${repoPath}/collaborators/octo-subscriber`, noContent),
      on("DELETE", `${repoPath}/invitations/77`, noContent),
    ]);
    expect(await app.removeCollaborator("42", REPO, "octo-subscriber")).toBe("removed");
    expect(await app.cancelInvitation("42", REPO, "77")).toBe("cancelled");
    expect(calls.slice(1).map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE ${API}${repoPath}/collaborators/octo-subscriber`,
      `DELETE ${API}${repoPath}/invitations/77`,
    ]);
  });

  it("keeps GitHub's 422 codes when an invitation is refused", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("PUT", `${repoPath}/collaborators/flagged`, () =>
        jsonResponse(422, {
          message: "Validation Failed",
          errors: [{ resource: "Repository", code: "custom", message: "flagged as spam" }],
        }),
      ),
    ]);
    const error = await failure(app.addCollaborator("42", REPO, "flagged"));
    expect(error).toMatchObject({ kind: "rejected", status: 422, githubErrorCodes: ["custom"] });
    expect(JSON.stringify(error) + error.message).not.toContain("spam");
  });

  it("classifies a missing permission, a rate limit and an outage on mutations", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("PUT", `${repoPath}/collaborators/forbidden`, () =>
        jsonResponse(403, { message: "Resource not accessible by integration" }),
      ),
      on("DELETE", `${repoPath}/collaborators/limited`, () =>
        jsonResponse(403, {}, { "x-ratelimit-remaining": "0", "retry-after": "45" }),
      ),
      on("DELETE", `${repoPath}/invitations/77`, () => jsonResponse(502, {})),
    ]);
    expect(await failure(app.addCollaborator("42", REPO, "forbidden"))).toMatchObject({
      kind: "rejected",
      status: 403,
      target: undefined,
    });
    expect(await failure(app.removeCollaborator("42", REPO, "limited"))).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 45_000,
    });
    expect(await failure(app.cancelInvitation("42", REPO, "77"))).toMatchObject({
      kind: "transient",
    });
  });

  describe("telling a missing repository from a missing account", () => {
    const repository = (status: number) =>
      on("GET", repoPath, () => jsonResponse(status, status === 200 ? { id: 9001 } : {}));

    it("checks the repository once after a 404 on a change", async () => {
      const { app, calls } = await client([tokenRoute("42"), repository(200)]);
      expect(await failure(app.addCollaborator("42", REPO, "octo-ghost"))).toMatchObject({
        kind: "not_found",
        status: 404,
        target: "account",
        message: "GitHub add collaborator failed with status 404",
      });
      expect(await app.removeCollaborator("42", REPO, "octo-ghost")).toBe("not_found");
      expect(await app.cancelInvitation("42", REPO, "77")).toBe("not_found");
      expect(calls.slice(1).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        `PUT ${repoPath}/collaborators/octo-ghost`,
        `GET ${repoPath}`,
        `DELETE ${repoPath}/collaborators/octo-ghost`,
        `GET ${repoPath}`,
        `DELETE ${repoPath}/invitations/77`,
        `GET ${repoPath}`,
      ]);
    });

    it("reports the repository as not found when it 404s too", async () => {
      const { app } = await client([tokenRoute("42"), repository(404)]);
      for (const call of [
        app.addCollaborator("42", REPO, "octo-ghost"),
        app.removeCollaborator("42", REPO, "octo-ghost"),
        app.cancelInvitation("42", REPO, "77"),
      ]) {
        expect(await failure(call)).toMatchObject({
          kind: "not_found",
          status: 404,
          target: "repository",
          message: "GitHub get repository failed with status 404",
        });
      }
    });

    it("passes on a failure of the repository check", async () => {
      const { app } = await client([tokenRoute("42"), repository(503)]);
      expect(await failure(app.removeCollaborator("42", REPO, "octo-ghost"))).toMatchObject({
        kind: "transient",
        target: undefined,
      });
    });

    it("needs no check for lists: their 404 is the repository", async () => {
      const { app, calls } = await client([tokenRoute("42")]);
      expect(await failure(app.listCollaborators("42", REPO, "direct"))).toMatchObject({
        kind: "not_found",
        target: "repository",
      });
      expect(await failure(app.listInvitations("42", REPO))).toMatchObject({
        target: "repository",
      });
      expect(calls).toHaveLength(3);
    });

    it("blames the installation, not the account, when the installation is gone", async () => {
      const { app, calls } = await client([]);
      const error = await failure(app.addCollaborator("404", REPO, "octo-subscriber"));
      expect(error).toMatchObject({ kind: "not_found", target: "installation" });
      expect(error.message).toBe("GitHub create installation token failed with status 404");
      expect(calls).toHaveLength(1);
      expect(await failure(app.listCollaborators("404", REPO, "all"))).toMatchObject({
        kind: "not_found",
        target: "installation",
      });
    });
  });
});

describe("getUserById", () => {
  it("looks the ID up with the installation token", async () => {
    const { app, calls } = await client([
      tokenRoute("42"),
      on("GET", "/user/7001", () =>
        jsonResponse(200, { id: 7001, login: "octo-renamed", type: "User" }),
      ),
    ]);
    expect(await app.getUserById("42", "7001")).toEqual({
      id: "7001",
      login: "octo-renamed",
      type: "User",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      url: `${API}/user/7001`,
      authorization: "Bearer ghs_token_42",
    });
  });

  it("reports an unknown ID as not_found and a bad body as malformed", async () => {
    const { app } = await client([
      tokenRoute("42"),
      on("GET", "/user/7002", () => jsonResponse(200, { id: 7002, login: "" })),
    ]);
    expect(await failure(app.getUserById("42", "7003"))).toMatchObject({
      kind: "not_found",
      target: undefined,
    });
    expect((await failure(app.getUserById("42", "7002"))).kind).toBe("malformed_response");
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
