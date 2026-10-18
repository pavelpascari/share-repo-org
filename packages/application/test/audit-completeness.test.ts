import { env } from "cloudflare:workers";
import { changedTables, snapshotTables } from "@sharerepo/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  createUserForSignIn,
  createWorkspace,
  type ProviderProfile,
  recordSignIn,
  recordSignOut,
  renameWorkspace,
  type ServiceContext,
} from "../src/index.ts";
import { githubProfile, login, serviceContext, uniqueSlug } from "./support/context.ts";

// Scenario audit/every-state-change-has-audit-event: random sequences of every state-changing
// service, including invalid, conflicting and unauthorized calls. After each call, either an
// audited table changed and an audit event carries the call's correlation ID, or the call
// changed nothing (a rejected or no-op call). A thrown error never leaves a partial change.

interface World {
  users: { userId: string; profile: ProviderProfile }[];
  slugs: string[];
}

type Command = (ctx: ServiceContext, world: World) => Promise<unknown>;

const pick = <T>(items: readonly T[], index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length];

const command = fc.oneof(
  fc.constant<Command>(async (ctx, world) => {
    const { userId } = await createUserForSignIn(ctx);
    const profile = githubProfile();
    world.users.push({ userId, profile });
    return userId;
  }),
  fc.tuple(fc.nat(), fc.boolean()).map(
    ([i, rename]): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        if (user === undefined) return;
        if (rename) user.profile = { ...user.profile, username: login(`renamed-${i % 1000}`) };
        return recordSignIn(ctx, user, user.profile);
      },
  ),
  fc.tuple(fc.nat(), fc.nat()).map(
    ([i, j]): Command =>
      async (ctx, world) => {
        // A second account for a user, or another user's account: both must be refused cleanly.
        const user = pick(world.users, i);
        const other = pick(world.users, j);
        if (user === undefined || other === undefined) return;
        return recordSignIn(ctx, user, user === other ? githubProfile() : other.profile);
      },
  ),
  fc.nat().map(
    (i): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        if (user !== undefined) await recordSignOut(ctx, user);
      },
  ),
  fc.tuple(fc.nat(), fc.constantFrom("Acme", "", "x".repeat(101)), fc.nat()).map(
    ([i, name, s]): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        if (user === undefined) return;
        // Sometimes reuse a slug, so the slug_taken path is exercised.
        const slug = s % 3 === 0 ? (pick(world.slugs, s) ?? uniqueSlug()) : uniqueSlug();
        const result = await createWorkspace(ctx, user, { name, slug });
        if (result.ok) world.slugs.push(result.workspace.slug);
        return result;
      },
  ),
  fc.tuple(fc.nat(), fc.nat(), fc.constantFrom("Renamed", "", "Acme")).map(
    ([i, s, name]): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        const slug = pick(world.slugs, s);
        if (user === undefined || slug === undefined) return;
        return renameWorkspace(ctx, user, slug, { name });
      },
  ),
  fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.constantFrom("owner", "member")).map(
    ([i, j, s, role]): Command =>
      async (ctx, world) => {
        const actor = pick(world.users, i);
        const member = pick(world.users, j);
        const slug = pick(world.slugs, s);
        if (actor === undefined || member === undefined || slug === undefined) return;
        return addWorkspaceMember(ctx, actor, slug, { userId: member.userId, role });
      },
  ),
);

async function auditCount(correlationId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM audit_events WHERE correlation_id = ?",
  )
    .bind(correlationId)
    .first<{ n: number }>();
  return Number(row?.n);
}

describe("audit/every-state-change-has-audit-event", () => {
  it("holds for random sequences of service calls", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 15 }), async (commands) => {
        const world: World = { users: [], slugs: [] };
        for (const run of commands) {
          const ctx = serviceContext();
          const before = await snapshotTables(env.DB);
          const failed = await run(ctx, world).then(
            () => false,
            () => true,
          );
          const changed = changedTables(before, await snapshotTables(env.DB));
          const audited = await auditCount(ctx.correlationId);
          if (failed) expect({ changed, audited }).toEqual({ changed: [], audited: 0 });
          else if (changed.length > 0) expect(audited).toBeGreaterThan(0);
        }
      }),
      { numRuns: 30 },
    );
    // Each run snapshots every table around every command; this is slow by design.
  }, 60_000);
});
