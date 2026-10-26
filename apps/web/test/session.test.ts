import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  getSignedInUser,
  requireUser,
  signOut,
  startGitHubSignIn,
} from "../app/auth/session.server.ts";
import { cloudflareContext } from "../app/context.ts";
import { fakeAccount } from "./support/fake-github.ts";
import { requestContext } from "./support/request-context.ts";
import { actions, BASE, sessionUser, signIn } from "./support/sign-in.ts";

const withCookie = (cookie: string, init: RequestInit = {}) =>
  new Request(`${BASE}/`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });

const signInRequest = (ip: string) =>
  new Request(`${BASE}/sign-in`, { method: "POST", headers: { "cf-connecting-ip": ip } });

describe("startGitHubSignIn", () => {
  it("redirects to GitHub with Better Auth's state cookies", async () => {
    const response = await startGitHubSignIn(signInRequest("203.0.113.1"), requestContext());
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(response.headers.getSetCookie().join("; ")).toContain("sharerepo.");
  });

  it("works without a client IP header (local development)", async () => {
    const request = new Request(`${BASE}/sign-in`, { method: "POST" });
    expect((await startGitHubSignIn(request, requestContext())).status).toBe(302);
  });

  it("is rate limited per client IP, with counters in D1", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await startGitHubSignIn(signInRequest("203.0.113.2"), requestContext());
      statuses.push(response.status);
    }
    expect(statuses).toEqual([302, 302, 302, 429]);
    const other = await startGitHubSignIn(signInRequest("203.0.113.3"), requestContext());
    expect(other.status).toBe(302);
    const counters = await env.DB.prepare(
      "SELECT count(*) AS n FROM auth_rate_limits WHERE key LIKE '203.0.113.2%'",
    ).first<{ n: number }>();
    expect(counters?.n).toBe(1);
  });
});

describe("session helpers", () => {
  it("resolves the signed-in user from the session cookie", async () => {
    const account = fakeAccount();
    const { cookie } = await signIn(account);
    const user = await getSignedInUser(withCookie(cookie), requestContext());
    expect(user).toEqual({
      userId: (await sessionUser(cookie))?.id,
      name: account.name,
      image: account.avatarUrl,
      sessionCreatedAt: expect.any(Number),
    });
    await expect(requireUser(withCookie(cookie), requestContext())).resolves.toEqual(user);
  });

  it("falls back to null image and redirects anonymous visitors home", async () => {
    const { cookie } = await signIn(fakeAccount({ avatarUrl: null }));
    expect((await getSignedInUser(withCookie(cookie), requestContext()))?.image).toBeNull();

    const anonymous = new Request(`${BASE}/w/acme`);
    await expect(getSignedInUser(anonymous, requestContext())).resolves.toBeNull();
    const redirect = await requireUser(anonymous, requestContext()).catch((e: unknown) => e);
    expect(redirect).toBeInstanceOf(Response);
    expect((redirect as Response).headers.get("location")).toBe("/");
  });
});

describe("signOut", () => {
  it("records auth.signed_out, ends the session and clears the cookie", async () => {
    const { cookie } = await signIn(fakeAccount());
    const context = requestContext({ correlationId: `corr-${crypto.randomUUID()}` });
    const response = await signOut(withCookie(cookie, { method: "POST" }), context);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.getSetCookie().join("; ")).toContain("Max-Age=0");
    expect(await sessionUser(cookie)).toBeNull();
    const { correlationId } = context.get(cloudflareContext);
    expect(await actions(correlationId)).toEqual(["auth.signed_out"]);
  });

  it("signs out an anonymous visitor without an audit event", async () => {
    const context = requestContext({ correlationId: `corr-${crypto.randomUUID()}` });
    const response = await signOut(withCookie("", { method: "POST" }), context);
    expect(response.status).toBe(302);
    expect(await actions(context.get(cloudflareContext).correlationId)).toEqual([]);
  });
});
