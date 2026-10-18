import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { createGitHubApp, GitHubApiError, type GitHubAppPort } from "../src/index.ts";
import { createFakeGitHubApp } from "../src/testing/index.ts";
import installation from "./fixtures/installation.json";
import suspendedInstallation from "./fixtures/installation-suspended.json";
import page1 from "./fixtures/repositories-page-1.json";
import page2 from "./fixtures/repositories-page-2.json";
import suspendedToken from "./fixtures/suspended-token.json";
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
const SUSPENDED_AT = Date.parse("2026-10-10T12:00:00Z");

function fakePort(): GitHubAppPort {
  const fake = createFakeGitHubApp();
  fake.addInstallation({ id: "42", account: ACCOUNT, repositories: REPOSITORIES });
  fake.addInstallation({ id: "43", account: ACCOUNT, suspendedAt: SUSPENDED_AT });
  return fake;
}

async function realPort(): Promise<GitHubAppPort> {
  const { fetch } = stubFetch([
    on("GET", "/app/installations/42", () => jsonResponse(200, installation)),
    on("GET", "/app/installations/43", () => jsonResponse(200, suspendedInstallation)),
    tokenRoute("42"),
    on("POST", "/app/installations/43/access_tokens", () => jsonResponse(403, suspendedToken)),
    ({ url }) => {
      if (url.pathname !== "/installation/repositories") return undefined;
      return url.searchParams.get("page") === "2"
        ? jsonResponse(200, page2)
        : jsonResponse(200, page1, {
            link: `<${API}/installation/repositories?per_page=100&page=2>; rel="next", <${API}/installation/repositories?per_page=100&page=2>; rel="last"`,
          });
    },
  ]);
  return createGitHubApp({
    appId: "1000",
    privateKeyPem: (await appKey()).pem,
    apiBaseUrl: API,
    fetch,
    clock: new FakeClock("2026-10-18T00:00:00Z"),
  });
}

describe.each([
  ["fake", async () => fakePort()],
  ["real client with documented responses", realPort],
])("GitHubAppPort contract: %s", (_, make) => {
  it("reads an active personal-account installation", async () => {
    const port = await make();
    await expect(port.getInstallation("42")).resolves.toEqual({
      id: "42",
      account: ACCOUNT,
      suspendedAt: null,
      permissions: { administration: "write", metadata: "read" },
      repositorySelection: "selected",
    });
  });

  it("lists every selected repository across pages, keyed by immutable ID", async () => {
    const port = await make();
    await expect(port.listInstallationRepositories("42")).resolves.toEqual(REPOSITORIES);
  });

  it("reports an unknown installation as not_found", async () => {
    const port = await make();
    const error = await port.getInstallation("404").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ kind: "not_found" });
  });

  it("shows a suspended installation, whose repositories cannot be read", async () => {
    const port = await make();
    await expect(port.getInstallation("43")).resolves.toMatchObject({ suspendedAt: SUSPENDED_AT });
    await expect(port.listInstallationRepositories("43")).rejects.toMatchObject({
      kind: "suspended",
    });
  });
});
