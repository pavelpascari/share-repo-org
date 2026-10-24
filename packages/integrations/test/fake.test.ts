import { FakeClock } from "@sharerepo/testing";
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

  it("resolves added users and installing accounts, but not enterprise accounts", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account });
    fake.addInstallation({ id: "2", account: { id: "8", login: "ent", type: "Enterprise" } });
    const bot = { id: "9", login: "Octo-Bot", type: "Bot" } as const;
    fake.addUser(bot);
    expect(await fake.getUserByLogin("1", "OCTO")).toEqual(account);
    const resolved = await fake.getUserByLogin("1", "octo-bot");
    expect(resolved).toEqual(bot);
    (resolved as { login: string }).login = "changed";
    expect(await fake.getUserByLogin("2", "octo-bot")).toEqual(bot);
    await expect(fake.getUserByLogin("1", "ent")).rejects.toMatchObject({ kind: "not_found" });
    await expect(fake.getUserByLogin("404", "octo")).rejects.toMatchObject({ kind: "not_found" });
    expect(fake.calls.filter((call) => call.startsWith("getUserByLogin"))).toEqual([
      "getUserByLogin:1",
      "getUserByLogin:1",
      "getUserByLogin:2",
      "getUserByLogin:1",
      "getUserByLogin:404",
    ]);
  });

  it("refuses an invalid login before recording a call", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account });
    await expect(fake.getUserByLogin("1", "..")).rejects.toMatchObject({ kind: "rejected" });
    expect(fake.calls).toEqual([]);
  });

  it("builds an install URL carrying the state", () => {
    expect(createFakeGitHubApp().installUrl("a b")).toBe(`${FAKE_INSTALL_BASE}?state=a%20b`);
  });
});

describe("fake GitHub collaborators and invitations", () => {
  const REPO = "octo/10";
  const subscriber = { id: "20", login: "subscriber", type: "User" } as const;

  function setup() {
    const clock = new FakeClock("2026-10-18T12:00:00Z");
    const fake = createFakeGitHubApp({ clock });
    fake.addInstallation({ id: "1", account, repositories: [repo("10")] });
    fake.addUser(subscriber);
    return { fake, clock };
  }

  it("invites, then the invitee accepts and becomes a write collaborator", async () => {
    const { fake, clock } = setup();
    const invited = await fake.addCollaborator("1", REPO, "Subscriber");
    expect(invited).toEqual({ outcome: "invited", invitationId: "1", createdAt: clock.now() });
    fake.acceptInvitation(REPO, "20");
    expect(await fake.listInvitations("1", REPO)).toEqual([]);
    expect(await fake.listCollaborators("1", REPO, "direct")).toEqual([
      { id: "20", login: "subscriber", permission: "write" },
    ]);
    expect(await fake.addCollaborator("1", REPO, "subscriber")).toEqual({
      outcome: "already_collaborator",
    });
  });

  it("issues a new invitation once the previous one expired", async () => {
    const { fake, clock } = setup();
    await fake.addCollaborator("1", REPO, "subscriber");
    fake.expireInvitation(REPO, "1");
    clock.advance(1000);
    expect(await fake.addCollaborator("1", REPO, "subscriber")).toMatchObject({
      invitationId: "2",
      createdAt: clock.now(),
    });
    expect((await fake.listInvitations("1", REPO)).map((i) => [i.id, i.expired])).toEqual([
      ["1", true],
      ["2", false],
    ]);
    expect(() => fake.acceptInvitation(REPO, "99")).toThrow("fake: no pending invitation");
    expect(() => fake.expireInvitation(REPO, "99")).toThrow("fake: unknown invitation 99");
  });

  it("adds and removes collaborators by hand, registering the account", async () => {
    const { fake } = setup();
    fake.addCollaboratorByHand(REPO, { id: "30", login: "friend" }, "admin");
    fake.addCollaboratorByHand(REPO, subscriber);
    expect(await fake.getUserById("1", "30")).toEqual({ id: "30", login: "friend", type: "User" });
    expect(fake.repositoryAccess(REPO).collaborators.map((c) => c.permission)).toEqual([
      "admin",
      "write",
    ]);
    fake.removeCollaboratorByHand(REPO, "30");
    expect(() => fake.removeCollaboratorByHand(REPO, "30")).toThrow("fake: 30 is not");
    expect(() => fake.addCollaboratorByHand("octo/none", subscriber)).toThrow(
      "fake: unknown repository octo/none",
    );
  });

  it("lists the owner only with affiliation all, unless also a direct collaborator", async () => {
    const { fake } = setup();
    expect(await fake.listCollaborators("1", REPO, "all")).toEqual([
      { id: "7", login: "octo", permission: "admin" },
    ]);
    fake.addCollaboratorByHand(REPO, { id: "7", login: "octo" }, "admin");
    expect(await fake.listCollaborators("1", REPO, "all")).toHaveLength(1);
  });

  it("omits an owner it does not know", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({
      id: "1",
      account: { id: "8", login: "ent", type: "Enterprise" },
      repositories: [{ ...repo("10"), ownerExternalId: "8" }],
    });
    expect(await fake.listCollaborators("1", REPO, "all")).toEqual([]);
  });

  it("keeps access across a rename and refuses the old name as a missing repository", async () => {
    const { fake } = setup();
    fake.addCollaboratorByHand(REPO, subscriber);
    fake.renameRepository("1", "10", "octo/renamed");
    await expect(fake.listCollaborators("1", REPO, "direct")).rejects.toMatchObject({
      kind: "not_found",
      target: "repository",
    });
    expect(await fake.listCollaborators("1", "octo/renamed", "direct")).toHaveLength(1);
  });

  it("does not cancel invitations when removing a collaborator (decision 0010)", async () => {
    const { fake } = setup();
    await fake.addCollaborator("1", REPO, "subscriber");
    expect(await fake.removeCollaborator("1", REPO, "subscriber")).toBe("not_found");
    expect(await fake.listInvitations("1", REPO)).toHaveLength(1);
    expect(await fake.cancelInvitation("1", REPO, "1")).toBe("cancelled");
    expect(fake.repositoryAccess(REPO).invitations).toEqual([]);
  });

  it("fails the next call of one operation with the given error", async () => {
    const { fake } = setup();
    const limited = new GitHubApiError("rate_limited", "limited", { retryAfterMs: 5000 });
    fake.failNext("addCollaborator", limited);
    await expect(fake.listInvitations("1", REPO)).resolves.toEqual([]);
    await expect(fake.addCollaborator("1", REPO, "subscriber")).rejects.toBe(limited);
    expect(fake.repositoryAccess(REPO).invitations).toEqual([]);
    await expect(fake.addCollaborator("1", REPO, "subscriber")).resolves.toMatchObject({
      outcome: "invited",
    });
  });

  it("performs the change but loses the response, once", async () => {
    const { fake } = setup();
    for (const operation of [
      "getInstallation",
      "listInstallationRepositories",
      "getUserByLogin",
      "addCollaborator",
    ] as const) {
      fake.loseNextResponse(operation);
    }
    await expect(fake.getInstallation("1")).rejects.toMatchObject({ kind: "transient" });
    await expect(fake.listInstallationRepositories("1")).rejects.toMatchObject({
      kind: "transient",
    });
    await expect(fake.getUserByLogin("1", "subscriber")).rejects.toMatchObject({
      kind: "transient",
    });
    await expect(fake.addCollaborator("1", REPO, "subscriber")).rejects.toMatchObject({
      kind: "transient",
      message: "GitHub addCollaborator failed: network error",
    });
    expect(fake.repositoryAccess(REPO).invitations).toHaveLength(1);
    await expect(fake.addCollaborator("1", REPO, "subscriber")).resolves.toMatchObject({
      invitationId: "1",
    });
  });

  it("records calls, but not ones refused for invalid input", async () => {
    const { fake } = setup();
    await expect(fake.addCollaborator("1", "bad", "subscriber")).rejects.toMatchObject({
      kind: "rejected",
    });
    await expect(fake.cancelInvitation("1", REPO, "x")).rejects.toMatchObject({
      kind: "rejected",
    });
    await expect(fake.getUserById("1", "0")).rejects.toMatchObject({ kind: "rejected" });
    expect(fake.calls).toEqual([]);
    await fake.listCollaborators("1", REPO, "direct");
    expect(fake.calls).toEqual(["listCollaborators:1"]);
  });

  it("returns copies, so callers cannot mutate its state", async () => {
    const { fake } = setup();
    fake.addCollaboratorByHand(REPO, subscriber);
    const listed = await fake.listCollaborators("1", REPO, "direct");
    (listed as unknown[]).length = 0;
    fake.repositoryAccess(REPO).collaborators.length = 0;
    expect(await fake.listCollaborators("1", REPO, "direct")).toHaveLength(1);
  });

  it("defaults to the system clock", async () => {
    const fake = createFakeGitHubApp();
    fake.addInstallation({ id: "1", account, repositories: [repo("10")] });
    fake.addUser(subscriber);
    const before = Date.now();
    const invited = await fake.addCollaborator("1", REPO, "subscriber");
    expect(invited.outcome === "invited" && invited.createdAt >= before).toBe(true);
  });
});
