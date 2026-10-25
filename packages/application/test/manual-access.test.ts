import { env } from "cloudflare:workers";
import { getManualAccess, listAuditEventsForWorkspace, markManualAccessesDue } from "@sharerepo/db";
import { GitHubApiError } from "@sharerepo/integrations";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  archiveOffer,
  cancelWorkspaceDeletion,
  deleteAccount,
  evaluateDueManualAccesses,
  evaluateManualAccess,
  exportWorkspace,
  grantManualAccess,
  listAccess,
  listManualAccess,
  recomputeOffer,
  reconcileResource,
  requestWorkspaceDeletion,
  revokeManualAccess,
  updateManualAccessEnd,
  updateOffer,
} from "../src/index.ts";
import {
  DAY,
  entitlementsOf,
  githubUser,
  live,
  memberOf,
  offer,
  type Shop,
  shop,
} from "./support/commerce.ts";
import { clock, db, serviceContext, signedUpUser } from "./support/context.ts";

// Manual access (decision 0016): an owner grants an offer's repositories to a GitHub account
// with no subscription. Scenario names from docs/testing-strategy.md.

const HOUR = 3_600_000;

beforeEach(() => {
  clock.set(Date.UTC(2026, 0, 1));
});

async function sold(): Promise<Shop & { offerId: string }> {
  const s = await shop(1, createFakeGitHubApp({ clock }));
  const sold = await offer(s, { items: [`sim_${crypto.randomUUID()}`] });
  return { ...s, offerId: sold.id };
}

const repoOf = (s: Shop) => (s.resources[0] as (typeof s.resources)[number]).nameSnapshot;
const reconcile = (s: Shop) =>
  reconcileResource(
    serviceContext(),
    { workspaceId: s.workspaceId, resourceId: (s.resources[0] as { id: string }).id },
    s.github,
  );

async function grant(
  s: Shop & { offerId: string },
  login: string,
  overrides: { endsAt?: number | null; note?: string } = {},
  ctx = serviceContext(),
) {
  return grantManualAccess(
    ctx,
    s,
    s.slug,
    { offerId: s.offerId, githubLogin: login, endsAt: null, note: "", ...overrides },
    { github: s.github },
  );
}

async function granted(s: Shop & { offerId: string }, overrides = {}) {
  const user = githubUser(s);
  const result = await grant(s, user.login, overrides);
  if (!result.ok) throw new Error(result.error);
  return { user, id: result.manualAccessId };
}

const auditOf = async (s: Shop) =>
  (await listAuditEventsForWorkspace(db, s.workspaceId)).filter(
    (e) => e.target.type === "manual_access" || e.target.type === "entitlement",
  );

/** Runs the minute sweep's manual access evaluations, as the jobs cron does. */
const sweep = () => evaluateDueManualAccesses(serviceContext(), { limit: 1_000 });

describe("manual/grant-provisions-without-subscription", () => {
  it("manual/grant-provisions-without-subscription: grants by login, stores the ID, and reconciliation invites", async () => {
    const s = await sold();
    const user = githubUser(s);
    const ctx = serviceContext();
    const result = await grant(
      s,
      user.login,
      { endsAt: clock.now() + 30 * DAY, note: " trial " },
      ctx,
    );
    expect(result).toEqual({ ok: true, manualAccessId: expect.any(String), login: user.login });
    if (!result.ok) return;
    const entitlements = live(await entitlementsOf(s.workspaceId));
    expect(entitlements).toEqual([
      expect.objectContaining({
        sourceType: "manual",
        sourceId: result.manualAccessId,
        subscriptionId: null,
        manualAccessId: result.manualAccessId,
        decisionReason: "manual",
        validUntil: clock.now() + 30 * DAY,
      }),
    ]);
    // Audited by the owner, with the account's immutable ID and the note as reason.
    const events = await listAuditEventsForWorkspace(db, s.workspaceId);
    const granting = events.filter((e) => e.correlationId === ctx.correlationId);
    expect(granting.map((e) => [e.action, e.actor])).toEqual([
      ["subject.created", { type: "user", id: s.userId }],
      ["access.granted_manually", { type: "user", id: s.userId }],
      ["entitlement.created", { type: "user", id: s.userId }],
    ]);
    expect(granting[1]).toMatchObject({
      reason: "trial",
      target: { type: "manual_access", id: result.manualAccessId },
      details: {
        offerId: s.offerId,
        externalSubjectId: user.id,
        endsAt: clock.now() + 30 * DAY,
      },
    });
    expect(JSON.stringify(granting)).not.toContain(user.login.toUpperCase());

    await reconcile(s);
    expect(s.github.repositoryAccess(repoOf(s)).invitations).toEqual([
      expect.objectContaining({ inviteeId: user.id }),
    ]);
    const view = await listAccess(serviceContext(), s, s.slug);
    expect(view.rows[0]?.entitlements[0]).toMatchObject({
      source: "manual",
      subscriptionId: null,
      manualAccessId: result.manualAccessId,
    });
  });

  it("lists the grant with its account, status and end date, and the offers that can be granted", async () => {
    const s = await sold();
    const archived = await offer(s, { items: [`sim_${crypto.randomUUID()}`], name: "Old" });
    await archiveOffer(serviceContext(), s, s.slug, archived.id);
    const { user, id } = await granted(s, { endsAt: clock.now() + DAY, note: "early buyer" });
    expect(await listManualAccess(serviceContext(), s, s.slug)).toEqual({
      offers: [{ id: s.offerId, name: "Pro" }],
      accesses: [
        {
          id,
          offerId: s.offerId,
          offerName: "Pro",
          login: user.login,
          githubUserId: user.id,
          endsAt: clock.now() + DAY,
          note: "early buyer",
          status: "active",
          revokedAt: null,
          revokeCause: null,
          grantedAt: clock.now(),
          liveEntitlements: 1,
        },
      ],
    });
  });

  it.each([
    [{ note: "line\nbreak" }, "note_invalid_characters"],
    [{ note: "a".repeat(501) }, "note_too_long"],
    [{ endsAt: Date.UTC(2026, 0, 1) }, "end_not_in_future"],
  ])("refuses %j with %s, before asking GitHub", async (overrides, error) => {
    const s = await sold();
    await expect(grant(s, "anyone", overrides)).resolves.toEqual({ ok: false, error });
    expect(s.github.calls.filter((call) => call.startsWith("getUserByLogin"))).toEqual([]);
  });

  it.each([
    ["not-a-login!", "login_invalid"],
    ["nobody-here", "login_not_found"],
  ])("refuses the login %s with %s", async (login, error) => {
    const s = await sold();
    await expect(grant(s, login)).resolves.toEqual({ ok: false, error });
  });

  it("refuses an organization, and an archived offer", async () => {
    const s = await sold();
    await expect(grant(s, githubUser(s, "Organization").login)).resolves.toEqual({
      ok: false,
      error: "account_not_user",
    });
    await archiveOffer(serviceContext(), s, s.slug, s.offerId);
    await expect(grant(s, githubUser(s).login)).resolves.toEqual({
      ok: false,
      error: "offer_unavailable",
    });
  });

  it("refuses without an active GitHub connection, and propagates GitHub failures", async () => {
    const s = await sold();
    s.github.failNext("transient");
    await expect(grant(s, githubUser(s).login)).rejects.toBeInstanceOf(GitHubApiError);
    s.github.suspend(s.installationId, clock.now());
    await env.DB.prepare("UPDATE connections SET status = 'suspended' WHERE workspace_id = ?")
      .bind(s.workspaceId)
      .run();
    await expect(grant(s, githubUser(s).login)).resolves.toEqual({
      ok: false,
      error: "connection_missing",
    });
  });
});

describe("manual/duplicate-grant-is-noop", () => {
  it("manual/duplicate-grant-is-noop: a replayed grant of the same offer and account writes nothing", async () => {
    const s = await sold();
    const { user } = await granted(s);
    const before = await auditOf(s);
    await expect(grant(s, user.login)).resolves.toEqual({ ok: false, error: "already_granted" });
    expect(await auditOf(s)).toEqual(before);
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
  });

  it("a replayed revoke and a repeated end date write nothing", async () => {
    const s = await sold();
    const { id } = await granted(s);
    await expect(
      updateManualAccessEnd(serviceContext(), s, s.slug, { manualAccessId: id, endsAt: null }),
    ).resolves.toEqual({ ok: true, outcome: "unchanged" });
    await expect(
      revokeManualAccess(serviceContext(), s, s.slug, { manualAccessId: id }),
    ).resolves.toEqual({ ok: true, outcome: "revoked" });
    const before = await auditOf(s);
    await expect(
      revokeManualAccess(serviceContext(), s, s.slug, { manualAccessId: id }),
    ).resolves.toEqual({ ok: true, outcome: "already_revoked" });
    await expect(
      updateManualAccessEnd(serviceContext(), s, s.slug, { manualAccessId: id, endsAt: null }),
    ).resolves.toEqual({ ok: false, error: "revoked" });
    expect(await auditOf(s)).toEqual(before);
  });
});

describe("manual/revoke-removes-access", () => {
  it("manual/revoke-removes-access: revoking ends the entitlement and reconciliation removes the collaborator", async () => {
    const s = await sold();
    const { user, id } = await granted(s);
    await reconcile(s);
    s.github.acceptInvitation(repoOf(s), user.id);
    await reconcile(s);
    expect(s.github.repositoryAccess(repoOf(s)).collaborators).toEqual([
      expect.objectContaining({ id: user.id }),
    ]);
    const ctx = serviceContext();
    await revokeManualAccess(ctx, s, s.slug, { manualAccessId: id });
    expect(await entitlementsOf(s.workspaceId)).toEqual([
      expect.objectContaining({ state: "revoked", decisionReason: "manual_revoked" }),
    ]);
    const events = (await listAuditEventsForWorkspace(db, s.workspaceId)).filter(
      (e) => e.correlationId === ctx.correlationId,
    );
    expect(events.map((e) => e.action)).toEqual(["access.revoked_manually", "entitlement.ended"]);
    expect(events[0]?.details).toEqual({
      offerId: s.offerId,
      subjectId: expect.any(String),
      externalSubjectId: user.id,
      cause: "owner",
    });
    await reconcile(s);
    expect(s.github.repositoryAccess(repoOf(s))).toEqual({ collaborators: [], invitations: [] });
    expect(await getManualAccess(db, { workspaceId: s.workspaceId, id })).toMatchObject({
      revokedAt: clock.now(),
      revokeCause: "owner",
      nextEvaluationAt: null,
    });
  });

  it("the account can be granted again once its access is revoked", async () => {
    const s = await sold();
    const { user, id } = await granted(s);
    await revokeManualAccess(serviceContext(), s, s.slug, { manualAccessId: id });
    const again = await grant(s, user.login);
    expect(again).toMatchObject({ ok: true });
  });
});

describe("manual/end-date-expires-via-sweep", () => {
  it("manual/end-date-expires-via-sweep: the minute sweep ends access at the end date, once", async () => {
    const s = await sold();
    const endsAt = clock.now() + DAY;
    const { id } = await granted(s, { endsAt });
    clock.set(endsAt - 1);
    await sweep();
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
    clock.set(endsAt + 30_000);
    await sweep();
    expect(await entitlementsOf(s.workspaceId)).toEqual([
      expect.objectContaining({ state: "expired", decisionReason: "manual_ended" }),
    ]);
    expect(await getManualAccess(db, { workspaceId: s.workspaceId, id })).toMatchObject({
      nextEvaluationAt: null,
      version: 2,
    });
    // timing/sweep-replay-is-idempotent: the same due row evaluated again changes nothing.
    const before = await auditOf(s);
    await sweep();
    await expect(
      evaluateManualAccess(serviceContext(), { workspaceId: s.workspaceId, manualAccessId: id }),
    ).resolves.toBe("unchanged");
    expect(await auditOf(s)).toEqual(before);
    expect((await listManualAccess(serviceContext(), s, s.slug)).accesses[0]?.status).toBe("ended");
    // The system's evaluation is audited, with no next timer.
    expect(
      before.filter((e) => e.action === "manual_access.evaluated").map((e) => e.details),
    ).toEqual([{ nextEvaluationAt: null }]);
  });

  it("a later end date grants an ended access again, with a new entitlement", async () => {
    const s = await sold();
    const { id } = await granted(s, { endsAt: clock.now() + HOUR });
    clock.advance(HOUR + 7 * HOUR);
    await sweep();
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
    await expect(
      updateManualAccessEnd(serviceContext(), s, s.slug, {
        manualAccessId: id,
        endsAt: clock.now() + DAY,
      }),
    ).resolves.toEqual({ ok: true, outcome: "updated" });
    const all = await entitlementsOf(s.workspaceId);
    expect(all.map((e) => e.state).sort()).toEqual(["active", "expired"]);
  });

  it("refuses an end date that is not in the future", async () => {
    const s = await sold();
    const { id } = await granted(s);
    await expect(
      updateManualAccessEnd(serviceContext(), s, s.slug, {
        manualAccessId: id,
        endsAt: clock.now(),
      }),
    ).resolves.toEqual({ ok: false, error: "end_not_in_future" });
  });

  it("an evaluation of an access that is gone is absent", async () => {
    await expect(
      evaluateManualAccess(serviceContext(), { workspaceId: "ws_none", manualAccessId: "ma_none" }),
    ).resolves.toBe("absent");
  });

  it("an evaluation that fails stays due and does not stop the others", async () => {
    const s = await sold();
    const { id } = await granted(s, { endsAt: clock.now() + DAY });
    clock.advance(DAY);
    // A due row naming a workspace it does not belong to cannot be evaluated: counted, skipped.
    const failing = new Proxy(db, {
      get: (target, property, receiver) =>
        property === "batch"
          ? () => Promise.reject(new Error("d1 down"))
          : Reflect.get(target, property, receiver),
    });
    const result = await evaluateDueManualAccesses(
      { ...serviceContext(), db: failing },
      {
        limit: 1_000,
      },
    );
    expect(result.failed).toBeGreaterThan(0);
    expect(await getManualAccess(db, { workspaceId: s.workspaceId, id })).toMatchObject({
      nextEvaluationAt: clock.now(),
    });
  });
});

describe("manual/follows-current-offer-version", () => {
  it("manual/follows-current-offer-version: an offer edit moves the entitlement to the new version; archiving revokes", async () => {
    const s = await shop(2, createFakeGitHubApp({ clock }));
    const sold = await offer(s, {
      items: [`sim_${crypto.randomUUID()}`],
      resources: s.resources.slice(0, 1),
    });
    const withOffer = { ...s, offerId: sold.id };
    await granted(withOffer);
    const edited = await updateOffer(serviceContext(), s, s.slug, sold.id, {
      name: "Pro",
      gracePeriodDays: 7,
      items: sold.items,
      accesses: s.resources.map((r) => ({ resourceId: r.id, accessLevel: "write" })),
    });
    expect(edited.ok).toBe(true);
    await recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: sold.id });
    await sweep();
    expect(
      live(await entitlementsOf(s.workspaceId))
        .map((e) => [e.offerVersion, e.resourceId])
        .sort(),
    ).toEqual(s.resources.map((r) => [2, r.id]).sort());
    await archiveOffer(serviceContext(), s, s.slug, sold.id);
    await recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: sold.id });
    await sweep();
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
    expect(
      (await entitlementsOf(s.workspaceId)).filter((e) => e.decisionReason === "offer_archived"),
    ).toHaveLength(2);
  });
});

describe("manual/workspace-deletion-withdraws-and-restores", () => {
  it("manual/workspace-deletion-withdraws-and-restores: a deletion withdraws manual access; cancelling grants it again", async () => {
    const s = await sold();
    const { id } = await granted(s);
    await requestWorkspaceDeletion(serviceContext(), s, s.slug, { confirmation: s.slug }, null);
    await sweep();
    expect(await entitlementsOf(s.workspaceId)).toEqual([
      expect.objectContaining({ state: "revoked", decisionReason: "workspace_deleted" }),
    ]);
    // Read-only while it is being deleted.
    await expect(
      revokeManualAccess(serviceContext(), s, s.slug, { manualAccessId: id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await cancelWorkspaceDeletion(serviceContext(), s, s.slug);
    await sweep();
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([
      expect.objectContaining({ decisionReason: "manual", sourceId: id }),
    ]);
  });
});

describe("manual/account-deletion-revokes-manual-access", () => {
  it("manual/account-deletion-revokes-manual-access: the recipient's account deletion revokes the grant for good", async () => {
    const s = await sold();
    const recipient = await signedUpUser();
    s.github.addUser({
      id: recipient.profile.externalUserId,
      login: recipient.profile.username,
      type: "User",
    });
    const result = await grant(s, recipient.profile.username);
    if (!result.ok) throw new Error(result.error);
    const deleted = await deleteAccount(serviceContext(), recipient, {
      confirmation: recipient.profile.username,
    });
    expect(deleted.ok).toBe(true);
    expect(await entitlementsOf(s.workspaceId)).toEqual([
      expect.objectContaining({ state: "revoked", decisionReason: "account_deleted" }),
    ]);
    expect(
      await getManualAccess(db, { workspaceId: s.workspaceId, id: result.manualAccessId }),
    ).toMatchObject({ revokeCause: "account_deleted", nextEvaluationAt: null });
    const revoked = (await listAuditEventsForWorkspace(db, s.workspaceId)).find(
      (e) => e.action === "access.revoked_manually",
    );
    expect(revoked).toMatchObject({
      actor: { type: "user", id: recipient.userId },
      details: { cause: "account_deleted", externalSubjectId: recipient.profile.externalUserId },
    });
    // An offer change later evaluates nothing back into existence.
    await recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: s.offerId });
    await sweep();
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
  });
});

describe("manual/open-limit-and-rate-limit", () => {
  it("manual/open-limit-and-rate-limit: at most 50 new grants a day per workspace", async () => {
    const s = await sold();
    await env.DB.prepare(
      "INSERT INTO claim_rate_limits (bucket, window_start, count) VALUES (?, ?, 50)",
    )
      .bind(`manual_access:${s.workspaceId}:d`, clock.now() - (clock.now() % DAY))
      .run();
    await expect(grant(s, githubUser(s).login)).resolves.toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  it("refuses a grant once the workspace has 100 open manual accesses", async () => {
    const s = await sold();
    const { id } = await granted(s);
    const access = await getManualAccess(db, { workspaceId: s.workspaceId, id });
    for (let i = 0; i < 99; i += 1) {
      await env.DB.prepare(
        `INSERT INTO subjects (id, workspace_id, provider, type, external_subject_id, login_snapshot, created_at, updated_at)
         VALUES (?1, ?2, 'github', 'user', ?1, 'filler', 0, 0)`,
      )
        .bind(`sub-fill-${s.workspaceId}-${i}`, s.workspaceId)
        .run();
      await env.DB.prepare(
        `INSERT INTO manual_accesses (id, workspace_id, offer_id, subject_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, 0, 0)`,
      )
        .bind(
          `ma-fill-${s.workspaceId}-${i}`,
          s.workspaceId,
          access?.offerId,
          `sub-fill-${s.workspaceId}-${i}`,
        )
        .run();
    }
    await expect(grant(s, githubUser(s).login)).resolves.toEqual({
      ok: false,
      error: "limit_reached",
    });
  });
});

describe("export/contains-no-secrets", () => {
  it("export/contains-no-secrets: the export lists manual accesses and names each entitlement's source", async () => {
    const s = await sold();
    const { id } = await granted(s, { note: "early buyer" });
    const exported = await exportWorkspace(serviceContext(), s, s.slug);
    if (!exported.ok) throw new Error(exported.reason);
    expect(exported.document.formatVersion).toBe(2);
    expect(exported.document.manualAccesses).toEqual([
      expect.objectContaining({ id, offerId: s.offerId, note: "early buyer", revokedAt: null }),
    ]);
    expect(exported.document.entitlements).toEqual([
      expect.objectContaining({ sourceType: "manual", manualAccessId: id, subscriptionId: null }),
    ]);
  });
});

describe("isolation and authorization", () => {
  it("isolation/cross-workspace-mutation-denied: an owner cannot revoke or edit another workspace's grant", async () => {
    const s = await sold();
    const other = await sold();
    const { id } = await granted(other);
    await expect(
      revokeManualAccess(serviceContext(), s, s.slug, { manualAccessId: id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateManualAccessEnd(serviceContext(), s, s.slug, { manualAccessId: id, endsAt: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Nor grant another workspace's offer, nor act in a workspace they do not belong to.
    await expect(
      grantManualAccess(
        serviceContext(),
        s,
        s.slug,
        { offerId: other.offerId, githubLogin: githubUser(s).login, endsAt: null, note: "" },
        { github: s.github },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      revokeManualAccess(serviceContext(), s, other.slug, { manualAccessId: id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(live(await entitlementsOf(other.workspaceId))).toHaveLength(1);
  });

  it("isolation/cross-workspace-read-denied: a member cannot list or grant; only owners can", async () => {
    const s = await sold();
    const member = await memberOf(s);
    await expect(listManualAccess(serviceContext(), member, s.slug)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      grantManualAccess(
        serviceContext(),
        member,
        s.slug,
        { offerId: s.offerId, githubLogin: githubUser(s).login, endsAt: null, note: "" },
        { github: s.github },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const outsider = await signedUpUser();
    await expect(listManualAccess(serviceContext(), outsider, s.slug)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// Security review (decision 0016): the batch re-checks what a decision was authorized and
// planned under, so changes that commit in between make it stale, never wrong.
describe("manual/concurrent-changes-converge", () => {
  it("manual/concurrent-changes-converge: a grant racing a deletion request grants nothing", async () => {
    const s = await sold();
    const user = githubUser(s);
    // GitHub answers after the deletion has been requested.
    const racing = {
      ...s.github,
      async getUserByLogin(installationId: string, login: string) {
        const found = await s.github.getUserByLogin(installationId, login);
        await requestWorkspaceDeletion(serviceContext(), s, s.slug, { confirmation: s.slug }, null);
        return found;
      },
    };
    await expect(
      grantManualAccess(
        serviceContext(),
        s,
        s.slug,
        { offerId: s.offerId, githubLogin: user.login, endsAt: null, note: "" },
        { github: racing },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);
    expect((await auditOf(s)).filter((e) => e.action === "access.granted_manually")).toEqual([]);
  });

  it("a grant by an owner demoted while GitHub answered writes nothing", async () => {
    const s = await sold();
    const user = githubUser(s);
    const racing = {
      ...s.github,
      async getUserByLogin(installationId: string, login: string) {
        const found = await s.github.getUserByLogin(installationId, login);
        await env.DB.prepare(
          "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?",
        )
          .bind(s.workspaceId, s.userId)
          .run();
        return found;
      },
    };
    await expect(
      grantManualAccess(
        serviceContext(),
        s,
        s.slug,
        { offerId: s.offerId, githubLogin: user.login, endsAt: null, note: "" },
        { github: racing },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);
  });

  it("a grant racing an offer edit is a conflict to retry, writing nothing", async () => {
    const s = await sold();
    const user = githubUser(s);
    const racing = {
      ...s.github,
      async getUserByLogin(installationId: string, login: string) {
        const found = await s.github.getUserByLogin(installationId, login);
        await archiveOffer(serviceContext(), s, s.slug, s.offerId);
        return found;
      },
    };
    await expect(
      grantManualAccess(
        serviceContext(),
        s,
        s.slug,
        { offerId: s.offerId, githubLogin: user.login, endsAt: null, note: "" },
        { github: racing },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);
  });

  it("a concurrent revoke and end date edit converge: the edit sees the revocation", async () => {
    const s = await sold();
    const { id } = await granted(s);
    const [revoked, edited] = await Promise.all([
      revokeManualAccess(serviceContext(), s, s.slug, { manualAccessId: id }),
      updateManualAccessEnd(serviceContext(), s, s.slug, {
        manualAccessId: id,
        endsAt: clock.now() + DAY,
      }),
    ]);
    expect(revoked).toEqual({ ok: true, outcome: "revoked" });
    expect([
      { ok: false, error: "revoked" },
      { ok: true, outcome: "updated" },
    ]).toContainEqual(edited);
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
    expect(await getManualAccess(db, { workspaceId: s.workspaceId, id })).toMatchObject({
      revokeCause: "owner",
    });
  });

  it("an owner's change that keeps losing to concurrent writers is a conflict", async () => {
    const s = await sold();
    const { id } = await granted(s);
    const bumping = new Proxy(db, {
      get: (target, property, receiver) =>
        property === "batch"
          ? async (statements: Parameters<typeof db.batch>[0]) => {
              await env.DB.prepare("UPDATE manual_accesses SET version = version + 1 WHERE id = ?")
                .bind(id)
                .run();
              return target.batch(statements);
            }
          : Reflect.get(target, property, receiver),
    });
    await expect(
      revokeManualAccess({ ...serviceContext(), db: bumping }, s, s.slug, { manualAccessId: id }),
    ).rejects.toBeInstanceOf(ConflictError);
    await markManualAccessesDue(db, { workspaceId: s.workspaceId, now: clock.now() });
    await expect(
      evaluateManualAccess(
        { ...serviceContext(), db: bumping },
        { workspaceId: s.workspaceId, manualAccessId: id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("two members of one workspace: a new owner may grant", async () => {
    const s = await sold();
    const second = await signedUpUser();
    await addWorkspaceMember(serviceContext(), s, s.slug, { userId: second.userId, role: "owner" });
    const result = await grantManualAccess(
      serviceContext(),
      second,
      s.slug,
      { offerId: s.offerId, githubLogin: githubUser(s).login, endsAt: null, note: "" },
      { github: s.github },
    );
    expect(result.ok).toBe(true);
  });
});
