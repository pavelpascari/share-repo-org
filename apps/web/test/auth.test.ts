import { env } from "cloudflare:workers";
import { schema } from "@sharerepo/db";
import { changedTables, expectNoCanaryLeak, snapshotTables } from "@sharerepo/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { syntheticEmail } from "../app/auth/auth.ts";
import { fakeAccount } from "./support/fake-github.ts";
import {
  actions,
  BASE,
  callback,
  canaries,
  db,
  github,
  sessionUser,
  signIn,
  startSignIn,
} from "./support/sign-in.ts";

describe("GitHub sign-in", () => {
  it("starts at GitHub's authorize URL with PKCE and no scopes", async () => {
    const { authorize } = await startSignIn();
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("test-client");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope") ?? "").toBe("");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
  });

  it("creates the user, auth profile, account and identity on first sign-in, all audited", async () => {
    const account = fakeAccount();
    const { response, cookie, correlationId } = await signIn(account);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const user = await sessionUser(cookie);
    expect(user).toMatchObject({ name: account.name, email: syntheticEmail(account.id) });

    const userId = user?.id ?? "";
    const [domainUser] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(domainUser).toBeDefined();
    const [authAccount] = await db
      .select()
      .from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, userId));
    expect(authAccount).toMatchObject({ providerId: "github", accountId: account.id });
    const [identity] = await db
      .select()
      .from(schema.externalIdentities)
      .where(eq(schema.externalIdentities.userId, userId));
    expect(identity).toMatchObject({ externalUserId: account.id, usernameSnapshot: account.login });

    expect(await actions(correlationId)).toEqual([
      "user.created",
      "identity.linked",
      "auth.signed_in",
    ]);
  });

  it("never stores or logs the GitHub access token", async () => {
    const { lines } = await signIn(fakeAccount());
    const stored = await Promise.all(
      ["auth_accounts", "auth_sessions", "auth_verifications", "audit_events"].map((table) =>
        env.DB.prepare(`SELECT * FROM ${table}`).all(),
      ),
    );
    expectNoCanaryLeak(stored, canaries);
    expectNoCanaryLeak(lines, canaries);
  });

  it("identity/username-change-keeps-identity", async () => {
    const account = fakeAccount();
    const first = await sessionUser((await signIn(account)).cookie);
    account.login = "renamed-octocat" as typeof account.login;
    const second = await signIn(account);

    expect((await sessionUser(second.cookie))?.id).toBe(first?.id);
    const identities = await db
      .select()
      .from(schema.externalIdentities)
      .where(eq(schema.externalIdentities.externalUserId, account.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]?.usernameSnapshot).toBe("renamed-octocat");
    expect(await actions(second.correlationId)).toEqual([
      "identity.snapshot_updated",
      "auth.signed_in",
    ]);
  });

  it("rejects a bad code: error redirect, no session, nothing audited", async () => {
    const started = await startSignIn();
    const state = started.authorize.searchParams.get("state") ?? "";
    const before = await snapshotTables(env.DB);
    const { response, cookie, correlationId } = await callback(
      `code=not-issued&state=${state}`,
      started.cookie,
    );
    expect(response.headers.get("location")).toContain("error=");
    expect(cookie).not.toContain("session_token");
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect(await actions(correlationId)).toEqual([]);
  });

  it("rejects a forged state without calling GitHub", async () => {
    const callsBefore = github.calls.length;
    const { response } = await callback(`code=${github.authorize(fakeAccount())}&state=forged`, "");
    // Better Auth's own error page is not routed; every failure lands on the home page's error.
    expect(response.headers.get("location")).toMatch(
      /^(http:\/\/localhost:5173)?\/\?error=sign_in_failed/,
    );
    expect(github.calls.length).toBe(callsBefore);
  });

  it("repairs a user whose auth account row is missing on the next sign-in", async () => {
    const account = fakeAccount();
    const first = await sessionUser((await signIn(account)).cookie);
    await db.delete(schema.authAccounts).where(eq(schema.authAccounts.accountId, account.id));

    const second = await signIn(account);
    expect(second.response.headers.get("location")).toBe("/");
    expect((await sessionUser(second.cookie))?.id).toBe(first?.id);
  });

  it("refuses sign-in when the GitHub identity belongs to another ShareRepo user", async () => {
    const account = fakeAccount();
    const owner = await sessionUser((await signIn(account)).cookie);
    // Corrupt the link: point the auth account at a different, fresh user.
    const other = fakeAccount();
    const otherUser = await sessionUser((await signIn(other)).cookie);
    await db
      .update(schema.authAccounts)
      .set({ userId: otherUser?.id ?? "" })
      .where(eq(schema.authAccounts.accountId, account.id));

    const attempt = await signIn(account);
    expect(attempt.response.headers.get("location")).toContain("error=");
    expect(attempt.cookie).not.toContain("session_token");
    expect(owner?.id).not.toBe(otherUser?.id);
    expect(attempt.lines.join("\n")).toContain('"reason":"identity_conflict"');
    expect(await actions(attempt.correlationId)).toContain("auth.sign_in_refused");
  });
});
