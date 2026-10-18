import { env } from "cloudflare:workers";
import { findExternalIdentity, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { ConflictError } from "@sharerepo/platform";
import { expectAuditedChange, expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { createUserForSignIn, recordSignIn, recordSignOut } from "../src/index.ts";
import {
  clock,
  db,
  githubProfile,
  login,
  serviceContext,
  signedUpUser,
} from "./support/context.ts";

const actions = async (correlationId: string) =>
  (await listAuditEventsByCorrelationId(db, correlationId)).map((event) => event.action);

describe("createUserForSignIn", () => {
  it("creates a user with a user.created audit event", async () => {
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createUserForSignIn(ctx),
    );
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events).toMatchObject([
      {
        action: "user.created",
        scope: "account",
        actor: { type: "user", id: result.userId },
        target: { type: "user", id: result.userId },
      },
    ]);
  });
});

describe("recordSignIn", () => {
  it("links the identity on first sign-in", async () => {
    const { userId } = await createUserForSignIn(serviceContext());
    const profile = githubProfile();
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      recordSignIn(ctx, { userId }, profile),
    );
    expect(result.outcome).toBe("linked");
    expect(await findExternalIdentity(db, profile)).toMatchObject({
      id: result.identityId,
      userId,
      usernameSnapshot: profile.username,
      displayNameSnapshot: profile.displayName,
      avatarUrlSnapshot: profile.avatarUrl,
      verifiedAt: clock.now(),
    });
    expect(await actions(ctx.correlationId)).toEqual(["identity.linked", "auth.signed_in"]);
  });

  it("identity/username-change-keeps-identity", async () => {
    const user = await signedUpUser();
    const first = await findExternalIdentity(db, user.profile);
    const renamed = { ...user.profile, username: login("new-login"), displayName: null };
    const ctx = serviceContext();
    clock.advance(1000);

    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      recordSignIn(ctx, { userId: user.userId }, renamed),
    );

    expect(result).toEqual({ identityId: first?.id, outcome: "renamed" });
    expect(await findExternalIdentity(db, user.profile)).toMatchObject({
      id: first?.id,
      userId: user.userId,
      usernameSnapshot: "new-login",
      displayNameSnapshot: null,
      verifiedAt: clock.now(),
    });
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events.map((event) => event.action)).toEqual([
      "identity.snapshot_updated",
      "auth.signed_in",
    ]);
    expect(events[0]?.details).toEqual({
      provider: "github",
      externalUserId: user.profile.externalUserId,
      previousUsername: user.profile.username,
      username: "new-login",
    });
  });

  it("refreshes the snapshot on a repeat sign-in with the same username", async () => {
    const user = await signedUpUser();
    const ctx = serviceContext();
    const result = await recordSignIn(ctx, { userId: user.userId }, user.profile);
    expect(result.outcome).toBe("refreshed");
    expect(await actions(ctx.correlationId)).toEqual(["auth.signed_in"]);
  });

  it("refuses a provider account linked to another user, changing nothing", async () => {
    const owner = await signedUpUser();
    const { userId: other } = await createUserForSignIn(serviceContext());
    const error = await expectNoChangeOnFailure(env.DB, () =>
      recordSignIn(serviceContext(), { userId: other }, owner.profile),
    );
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("refuses to link a second provider account to the same user", async () => {
    const user = await signedUpUser();
    const error = await expectNoChangeOnFailure(env.DB, () =>
      recordSignIn(serviceContext(), { userId: user.userId }, githubProfile()),
    );
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("refuses when the identity is reassigned between the read and the guarded update", async () => {
    const user = await signedUpUser();
    const { userId: other } = await createUserForSignIn(serviceContext());
    const ctx = serviceContext();
    // Interpose on the batch: just before the update runs, the identity moves to another user.
    const racingDb = new Proxy(ctx.db, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: Parameters<typeof target.batch>[0]) => {
          await env.DB.prepare(
            "UPDATE external_identities SET user_id = ? WHERE external_user_id = ?",
          )
            .bind(other, user.profile.externalUserId)
            .run();
          return target.batch(statements);
        };
      },
    });
    await expect(
      recordSignIn({ ...ctx, db: racingDb }, { userId: user.userId }, user.profile),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await actions(ctx.correlationId)).toEqual([]);
  });

  it("links exactly once when the same first sign-in is recorded concurrently", async () => {
    const { userId } = await createUserForSignIn(serviceContext());
    const profile = githubProfile();
    const outcomes = await Promise.all([
      recordSignIn(serviceContext(), { userId }, profile),
      recordSignIn(serviceContext(), { userId }, profile),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["linked", "refreshed"]);
    expect(new Set(outcomes.map((o) => o.identityId)).size).toBe(1);
  });

  it("gives a concurrent first sign-in by another user a conflict", async () => {
    const [a, b] = await Promise.all([
      createUserForSignIn(serviceContext()),
      createUserForSignIn(serviceContext()),
    ]);
    const profile = githubProfile();
    const results = await Promise.allSettled([
      recordSignIn(serviceContext(), a, profile),
      recordSignIn(serviceContext(), b, profile),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ConflictError);
  });
});

describe("recordSignOut", () => {
  it("writes an auth.signed_out audit event", async () => {
    const user = await signedUpUser();
    const ctx = serviceContext();
    await recordSignOut(ctx, user);
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      { action: "auth.signed_out", actor: { id: user.userId }, target: { id: user.userId } },
    ]);
  });
});
