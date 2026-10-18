import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../src/index.ts";
import { createFakeGitHubApp, FAKE_INSTALL_BASE } from "../src/testing/index.ts";

const account = { id: "7", login: "octo", type: "User" } as const;
const repo = (externalId: string, name = `octo/${externalId}`) => ({
  externalId,
  name,
  ownerExternalId: "7",
  ownerType: "User" as const,
  private: true,
  archived: false,
});

describe("fake GitHub App controls", () => {
  it("defaults permissions and records calls", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account });
    expect((await fake.getInstallation("1")).permissions).toEqual({
      administration: "write",
      metadata: "read",
    });
    expect(await fake.listInstallationRepositories("1")).toEqual([]);
    expect(fake.calls).toEqual(["getInstallation:1", "listInstallationRepositories:1"]);
  });

  it("returns copies, so callers cannot mutate its state", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account, repositories: [repo("10")], permissions: { a: "b" } });
    const repos = await fake.listInstallationRepositories("1");
    (repos as unknown[]).length = 0;
    expect(await fake.listInstallationRepositories("1")).toHaveLength(1);
  });

  it("sets, renames and removes repositories", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account, repositories: [repo("10")] });
    fake.setRepositories("1", [repo("10"), repo("11")]);
    fake.renameRepository("1", "10", "octo/renamed");
    fake.removeRepository("1", "11");
    expect(await fake.listInstallationRepositories("1")).toEqual([repo("10", "octo/renamed")]);
  });

  it("suspends, unsuspends and deletes installations", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account });
    fake.suspend("1", 123);
    expect((await fake.getInstallation("1")).suspendedAt).toBe(123);
    fake.unsuspend("1");
    expect((await fake.getInstallation("1")).suspendedAt).toBeNull();
    fake.deleteInstallation("1");
    await expect(fake.getInstallation("1")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("fails the next call once with the requested kind", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account });
    fake.failNext("rate_limited");
    const error = await fake.getInstallation("1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ kind: "rate_limited" });
    await expect(fake.getInstallation("1")).resolves.toMatchObject({ id: "1" });
  });

  it("refuses controls on unknown installations", () => {
    const fake = createFakeGitHubApp();
    expect(() => fake.suspend("9", 1)).toThrow("fake: unknown installation 9");
  });

  it("builds an install URL carrying the state", () => {
    expect(createFakeGitHubApp().installUrl("a b")).toBe(`${FAKE_INSTALL_BASE}?state=a%20b`);
  });
});
