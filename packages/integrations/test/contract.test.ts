import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { createGitHubApp, GitHubApiError, type GitHubAppPort } from "../src/index.ts";
import { createFakeGitHubApp, type FakeGitHubOperation } from "../src/testing/index.ts";
import collaboratorsAll1 from "./fixtures/collaborators-all-page-1.json";
import collaborators1 from "./fixtures/collaborators-page-1.json";
import collaborators2 from "./fixtures/collaborators-page-2.json";
import installation from "./fixtures/installation.json";
import suspendedInstallation from "./fixtures/installation-suspended.json";
import invitationCreated from "./fixtures/invitation-created.json";
import invitations from "./fixtures/invitations.json";
import page1 from "./fixtures/repositories-page-1.json";
import page2 from "./fixtures/repositories-page-2.json";
import suspendedToken from "./fixtures/suspended-token.json";
import user from "./fixtures/user.json";
import userById from "./fixtures/user-by-id.json";
import { appKey } from "./support/keys.ts";
import { API, jsonResponse, on, stubFetch, tokenRoute } from "./support/stub-fetch.ts";

// One contract for GitHubAppPort, run against the in-memory fake and against the real client
// replaying documented GitHub responses. If the fake drifts from GitHub's behaviour, its run fails.

const ACCOUNT = { id: "5001", login: "octo-creator", type: "User" } as const;
const REPOSITORIES = [
  {
    externalId: "9001",
    name: "octo-creator/course-code",
    ownerExternalId: "5001",
    ownerType: "User",
    private: true,
    archived: false,
  },
  {
    externalId: "9002",
    name: "octo-creator/starter-kit",
    ownerExternalId: "5001",
    ownerType: "User",
    private: true,
    archived: true,
  },
  {
    externalId: "9003",
    name: "octo-creator/public-notes",
    ownerExternalId: "5001",
    ownerType: "User",
    private: false,
    archived: false,
  },
] as const;
const SUBSCRIBER = { id: "6001", login: "octo-subscriber", type: "User" } as const;
const MEMBER = { id: "6002", login: "octo-member", type: "User" } as const;
const READER = { id: "6003", login: "octo-reader", type: "User" } as const;
const PENDING = { id: "6004", login: "octo-pending", type: "User" } as const;
const LAPSED = { id: "6005", login: "octo-lapsed", type: "User" } as const;
const NEWCOMER = { id: "6010", login: "octo-newcomer", type: "User" } as const;
const SUSPENDED_AT = Date.parse("2026-10-10T12:00:00Z");
const NOW = "2026-10-18T00:00:00Z";
const REPO = "octo-creator/course-code";
const REPO_PATH = `/repos/${REPO}`;
const GONE = "octo-creator/renamed-away";

const DIRECT = [
  { id: SUBSCRIBER.id, login: SUBSCRIBER.login, permission: "write" },
  { id: MEMBER.id, login: MEMBER.login, permission: "write" },
  { id: READER.id, login: READER.login, permission: "read" },
];
const OWNER = { id: ACCOUNT.id, login: ACCOUNT.login, permission: "admin" };
const INVITATIONS = [
  {
    inviteeId: LAPSED.id,
    inviteeLogin: LAPSED.login,
    createdAt: Date.parse("2026-10-01T09:00:00Z"),
    expired: true,
  },
  {
    inviteeId: PENDING.id,
    inviteeLogin: PENDING.login,
    createdAt: Date.parse("2026-10-17T08:30:00Z"),
    expired: false,
  },
];
const ID = expect.stringMatching(/^[1-9][0-9]*$/);

interface Subject {
  readonly port: GitHubAppPort;
  /** The next call of `operation` is refused by GitHub's rate limit, with `retry-after: 30`. */
  rateLimitNext(operation: FakeGitHubOperation): void;
}

async function fakePort(): Promise<Subject> {
  const clock = new FakeClock("2026-10-01T09:00:00Z");
  const fake = createFakeGitHubApp({ clock });
  fake.addInstallation({ id: "42", account: ACCOUNT, repositories: REPOSITORIES });
  fake.addInstallation({ id: "43", account: ACCOUNT, suspendedAt: SUSPENDED_AT });
  for (const account of [SUBSCRIBER, MEMBER, READER, PENDING, LAPSED, NEWCOMER]) {
    fake.addUser(account);
  }
  fake.addCollaboratorByHand(REPO, SUBSCRIBER);
  fake.addCollaboratorByHand(REPO, MEMBER);
  fake.addCollaboratorByHand(REPO, READER, "read");
  const lapsed = await fake.addCollaborator("42", REPO, LAPSED.login);
  if (lapsed.outcome === "invited") fake.expireInvitation(REPO, lapsed.invitationId);
  clock.set("2026-10-17T08:30:00Z");
  await fake.addCollaborator("42", REPO, PENDING.login);
  clock.set(NOW);
  return {
    port: fake,
    rateLimitNext: (operation) =>
      fake.failNext(
        operation,
        new GitHubApiError("rate_limited", "GitHub failed with status 429", {
          status: 429,
          retryAfterMs: 30_000,
        }),
      ),
  };
}

async function realPort(): Promise<Subject> {
  let limited = false;
  const page = (url: URL, first: unknown, next: string) =>
    url.searchParams.get("page") === "2"
      ? jsonResponse(200, collaborators2)
      : jsonResponse(200, first, {
          link: `<${API}${REPO_PATH}/collaborators?${next}&per_page=100&page=2>; rel="next", <${API}${REPO_PATH}/collaborators?${next}&per_page=100&page=2>; rel="last"`,
        });
  const { fetch } = stubFetch([
    ({ url }) => {
      if (!limited || !url.pathname.startsWith("/repos/")) return undefined;
      limited = false;
      return jsonResponse(429, { message: "API rate limit exceeded" }, { "retry-after": "30" });
    },
    on("GET", "/app/installations/42", () => jsonResponse(200, installation)),
    on("GET", "/app/installations/43", () => jsonResponse(200, suspendedInstallation)),
    tokenRoute("42"),
    on("POST", "/app/installations/43/access_tokens", () => jsonResponse(403, suspendedToken)),
    // GitHub matches logins case-insensitively and answers with the canonical spelling.
    ({ method, url }) =>
      method === "GET" && url.pathname.toLowerCase() === "/users/octo-subscriber"
        ? jsonResponse(200, user)
        : undefined,
    on("GET", "/user/6001", () => jsonResponse(200, userById)),
    ({ url }) => {
      if (url.pathname !== "/installation/repositories") return undefined;
      return url.searchParams.get("page") === "2"
        ? jsonResponse(200, page2)
        : jsonResponse(200, page1, {
            link: `<${API}/installation/repositories?per_page=100&page=2>; rel="next", <${API}/installation/repositories?per_page=100&page=2>; rel="last"`,
          });
    },
    on("GET", REPO_PATH, () => jsonResponse(200, page1.repositories[0])),
    ({ method, url }) => {
      if (method !== "GET" || url.pathname !== `${REPO_PATH}/collaborators`) return undefined;
      return url.searchParams.get("affiliation") === "all"
        ? page(url, collaboratorsAll1, "affiliation=all")
        : page(url, collaborators1, "affiliation=direct");
    },
    on("GET", `${REPO_PATH}/invitations`, () => jsonResponse(200, invitations)),
    on("PUT", `${REPO_PATH}/collaborators/octo-pending`, () =>
      jsonResponse(201, invitationCreated),
    ),
    on("PUT", `${REPO_PATH}/collaborators/octo-newcomer`, () =>
      jsonResponse(201, {
        ...invitationCreated,
        id: 8104,
        invitee: { ...invitationCreated.invitee, id: 6010, login: "octo-newcomer" },
        created_at: NOW,
      }),
    ),
    on(
      "PUT",
      `${REPO_PATH}/collaborators/octo-subscriber`,
      () => new Response(null, { status: 204 }),
    ),
    on(
      "DELETE",
      `${REPO_PATH}/collaborators/octo-subscriber`,
      () => new Response(null, { status: 204 }),
    ),
    on("DELETE", `${REPO_PATH}/invitations/8103`, () => new Response(null, { status: 204 })),
  ]);
  return {
    port: createGitHubApp({
      appId: "1000",
      privateKeyPem: (await appKey()).pem,
      apiBaseUrl: API,
      fetch,
      clock: new FakeClock(NOW),
    }),
    rateLimitNext: () => {
      limited = true;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<GitHubApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubApiError);
  return error as GitHubApiError;
}

describe.each([
  ["fake", fakePort],
  ["real client with documented responses", realPort],
])("GitHubAppPort contract: %s", (_, make) => {
  it("reads an active personal-account installation", async () => {
    const { port } = await make();
    await expect(port.getInstallation("42")).resolves.toEqual({
      id: "42",
      account: ACCOUNT,
      suspendedAt: null,
      permissions: { administration: "write", metadata: "read" },
      repositorySelection: "selected",
    });
  });

  it("lists every selected repository across pages, keyed by immutable ID", async () => {
    const { port } = await make();
    await expect(port.listInstallationRepositories("42")).resolves.toEqual(REPOSITORIES);
  });

  it("reports an unknown installation as not_found", async () => {
    const { port } = await make();
    const error = await failure(port.getInstallation("404"));
    expect(error).toMatchObject({ kind: "not_found" });
  });

  it("shows a suspended installation, whose repositories cannot be read", async () => {
    const { port } = await make();
    await expect(port.getInstallation("43")).resolves.toMatchObject({ suspendedAt: SUSPENDED_AT });
    await expect(port.listInstallationRepositories("43")).rejects.toMatchObject({
      kind: "suspended",
    });
  });

  it("resolves a login to the immutable user ID and canonical login", async () => {
    const { port } = await make();
    await expect(port.getUserByLogin("42", "octo-subscriber")).resolves.toEqual(SUBSCRIBER);
    await expect(port.getUserByLogin("42", "Octo-Subscriber")).resolves.toEqual(SUBSCRIBER);
  });

  it("reports an unknown login as not_found", async () => {
    const { port } = await make();
    const error = await failure(port.getUserByLogin("42", "nobody-here"));
    expect(error).toMatchObject({ kind: "not_found" });
  });

  it("refuses an invalid login as rejected, without echoing it", async () => {
    const { port } = await make();
    for (const login of ["", "..", "a/b", "x".repeat(40)]) {
      const error = await failure(port.getUserByLogin("42", login));
      expect(error).toMatchObject({ kind: "rejected" });
      if (login !== "") expect(error.message).not.toContain(login);
    }
  });

  it("cannot resolve logins through a suspended installation", async () => {
    const { port } = await make();
    await expect(port.getUserByLogin("43", "octo-subscriber")).rejects.toMatchObject({
      kind: "suspended",
    });
  });

  it("resolves an immutable user ID to the current login", async () => {
    const { port } = await make();
    await expect(port.getUserById("42", "6001")).resolves.toEqual(SUBSCRIBER);
    expect(await failure(port.getUserById("42", "999999"))).toMatchObject({ kind: "not_found" });
    for (const id of ["0", "-1", "01", "abc", "", "6001/x"]) {
      expect(await failure(port.getUserById("42", id))).toMatchObject({ kind: "rejected" });
    }
  });

  it("lists direct collaborators across pages, with their highest permission", async () => {
    const { port } = await make();
    await expect(port.listCollaborators("42", REPO, "direct")).resolves.toEqual(DIRECT);
  });

  it("lists the owner's indirect access only with affiliation all", async () => {
    const { port } = await make();
    await expect(port.listCollaborators("42", REPO, "all")).resolves.toEqual([OWNER, ...DIRECT]);
  });

  it("lists invitations, expired ones included, skipping email invitations", async () => {
    const { port } = await make();
    const listed = await port.listInvitations("42", REPO);
    expect(listed).toEqual(INVITATIONS.map((invitation) => ({ ...invitation, id: ID })));
  });

  it("invites an account and returns the invitation", async () => {
    const { port } = await make();
    await expect(port.addCollaborator("42", REPO, NEWCOMER.login)).resolves.toEqual({
      outcome: "invited",
      invitationId: ID,
      createdAt: Date.parse(NOW),
    });
  });

  it("returns the pending invitation when an invitee is invited again", async () => {
    const { port } = await make();
    const pending = (await port.listInvitations("42", REPO)).find(
      (invitation) => invitation.inviteeId === PENDING.id,
    );
    await expect(port.addCollaborator("42", REPO, PENDING.login)).resolves.toEqual({
      outcome: "invited",
      invitationId: pending?.id,
      createdAt: pending?.createdAt,
    });
  });

  it("sends nothing new for an existing collaborator", async () => {
    const { port } = await make();
    await expect(port.addCollaborator("42", REPO, SUBSCRIBER.login)).resolves.toEqual({
      outcome: "already_collaborator",
    });
  });

  it("reports an unknown account to invite as not_found, target account", async () => {
    const { port } = await make();
    const error = await failure(port.addCollaborator("42", REPO, "octo-ghost"));
    expect(error).toMatchObject({ kind: "not_found", status: 404, target: "account" });
  });

  it("removes a collaborator, and reports one already gone as not_found", async () => {
    const { port } = await make();
    await expect(port.removeCollaborator("42", REPO, SUBSCRIBER.login)).resolves.toBe("removed");
    await expect(port.removeCollaborator("42", REPO, "octo-stranger")).resolves.toBe("not_found");
  });

  it("cancels an invitation, and reports one already gone as not_found", async () => {
    const { port } = await make();
    const pending = (await port.listInvitations("42", REPO)).find(
      (invitation) => invitation.inviteeId === PENDING.id,
    );
    await expect(port.cancelInvitation("42", REPO, pending?.id ?? "")).resolves.toBe("cancelled");
    await expect(port.cancelInvitation("42", REPO, "999999")).resolves.toBe("not_found");
  });

  it("reports a renamed or removed repository as not_found, target repository", async () => {
    const { port } = await make();
    const calls = [
      port.listCollaborators("42", GONE, "direct"),
      port.listInvitations("42", GONE),
      port.addCollaborator("42", GONE, SUBSCRIBER.login),
      port.removeCollaborator("42", GONE, SUBSCRIBER.login),
      port.cancelInvitation("42", GONE, "8103"),
    ];
    for (const call of calls) {
      expect(await failure(call)).toMatchObject({ kind: "not_found", target: "repository" });
    }
  });

  it("refuses an invalid repository, login or invitation ID as rejected", async () => {
    const { port } = await make();
    for (const repo of ["course-code", "a/b/c", "octo-creator/..", "../course-code", ""]) {
      expect(await failure(port.listInvitations("42", repo))).toMatchObject({ kind: "rejected" });
    }
    expect(await failure(port.addCollaborator("42", REPO, ".."))).toMatchObject({
      kind: "rejected",
    });
    expect(await failure(port.removeCollaborator("42", REPO, "a/b"))).toMatchObject({
      kind: "rejected",
    });
    expect(await failure(port.cancelInvitation("42", REPO, ".."))).toMatchObject({
      kind: "rejected",
    });
  });

  it("cannot read or change collaborators through a suspended installation", async () => {
    const { port } = await make();
    expect(await failure(port.listCollaborators("43", REPO, "direct"))).toMatchObject({
      kind: "suspended",
    });
    expect(await failure(port.addCollaborator("43", REPO, NEWCOMER.login))).toMatchObject({
      kind: "suspended",
    });
  });

  it.each([
    "listCollaborators",
    "listInvitations",
    "addCollaborator",
    "removeCollaborator",
    "cancelInvitation",
  ] as const)("reports a rate limit on %s with the delay before retrying", async (operation) => {
    const { port, rateLimitNext } = await make();
    rateLimitNext(operation);
    const call = {
      listCollaborators: () => port.listCollaborators("42", REPO, "direct"),
      listInvitations: () => port.listInvitations("42", REPO),
      addCollaborator: () => port.addCollaborator("42", REPO, NEWCOMER.login),
      removeCollaborator: () => port.removeCollaborator("42", REPO, SUBSCRIBER.login),
      cancelInvitation: () => port.cancelInvitation("42", REPO, "8103"),
    }[operation];
    expect(await failure(call())).toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
  });
});
