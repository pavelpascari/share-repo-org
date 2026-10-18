import { env } from "cloudflare:workers";
import { getOfferVersion, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { parseOfferSnapshot } from "@sharerepo/domain";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { expectAuditedChange } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  archiveOffer,
  createOffer,
  decodeOfferKey,
  listOfferableResources,
  listOffers,
  type OfferResult,
  resyncConnection,
  type UserActor,
  updateOffer,
} from "../src/index.ts";
import { failingBatches, memberOf, offer, type Shop, shop } from "./support/commerce.ts";
import { db, serviceContext, signedUpUser } from "./support/context.ts";

const input = (s: Shop, overrides: Record<string, unknown> = {}) => ({
  name: "Pro",
  gracePeriodDays: 5,
  items: [{ source: "simulated", externalItemId: `sim_${crypto.randomUUID().slice(0, 8)}` }],
  accesses: s.resources.map((resource) => ({ resourceId: resource.id, accessLevel: "write" })),
  ...overrides,
});

function ok(result: OfferResult) {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

describe("createOffer", () => {
  it("creates version 1 with an immutable snapshot, audited", async () => {
    const s = await shop();
    const ctx = serviceContext();
    const config = input(s);
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createOffer(ctx, s, s.slug, config),
    );
    const { offer: created, outboxId } = ok(result);
    expect(created).toMatchObject({
      name: "Pro",
      status: "active",
      version: 1,
      gracePeriodDays: 5,
      items: config.items,
      accesses: config.accesses,
    });
    expect(outboxId).toBeNull();
    const version = await getOfferVersion(db, {
      workspaceId: s.workspaceId,
      offerId: created.id,
      version: 1,
    });
    expect(version?.createdByUserId).toBe(s.userId);
    expect(parseOfferSnapshot(JSON.parse(version?.snapshot ?? "null"))).toEqual({
      ok: true,
      value: { name: "Pro", gracePeriodDays: 5, items: config.items, accesses: config.accesses },
    });
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      {
        action: "offer.created",
        details: { name: "Pro", version: 1, gracePeriodDays: 5, items: 1, accesses: 1 },
      },
    ]);
  });

  it.each([
    ["an invalid name", { name: " " }, [{ field: "input", code: "name_invalid" }]],
    ["no access", { accesses: [] }, [{ field: "input", code: "access_required" }]],
    [
      "an unknown repository",
      { accesses: [{ resourceId: "nope", accessLevel: "write" }] },
      [{ field: "access", resourceId: "nope", code: "resource_not_found" }],
    ],
  ])("refuses %s and writes nothing", async (_, overrides, errors) => {
    const s = await shop();
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createOffer(ctx, s, s.slug, input(s, overrides)),
    );
    expect(result).toEqual({ ok: false, errors });
    expect(changedTables).toEqual([]);
  });

  it("refuses read access to a repository that can only grant write", async () => {
    const s = await shop();
    const [resource] = s.resources;
    await expect(
      createOffer(
        serviceContext(),
        s,
        s.slug,
        input(s, { accesses: [{ resourceId: resource?.id, accessLevel: "read" }] }),
      ),
    ).resolves.toEqual({
      ok: false,
      errors: [{ field: "access", resourceId: resource?.id, code: "access_level_unsupported" }],
    });
  });

  it("refuses a repository that is not sellable", async () => {
    const s = await shop();
    const [resource] = s.resources;
    await env.DB.prepare("UPDATE resources SET archived = 1 WHERE id = ?").bind(resource?.id).run();
    await expect(createOffer(serviceContext(), s, s.slug, input(s))).resolves.toEqual({
      ok: false,
      errors: [{ field: "access", resourceId: resource?.id, code: "resource_not_sellable" }],
    });
  });

  it("refuses an item another offer already sells", async () => {
    const s = await shop();
    const config = input(s);
    ok(await createOffer(serviceContext(), s, s.slug, config));
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createOffer(ctx, s, s.slug, { ...config, name: "Copy" }),
    );
    expect(result).toEqual({ ok: false, errors: [{ field: "items", code: "item_taken" }] });
    expect(changedTables).toEqual([]);
  });

  it("is refused for members and non-members", async () => {
    const s = await shop();
    const member = await memberOf(s);
    const stranger = await signedUpUser();
    const create = (actor: UserActor) => createOffer(serviceContext(), actor, s.slug, input(s));
    await expect(create(member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(create(stranger)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("propagates unexpected storage failures", async () => {
    const s = await shop();
    await expect(createOffer(failingBatches(), s, s.slug, input(s))).rejects.toThrow("d1 down");
  });
});

describe("listOffers and listOfferableResources", () => {
  it("lets any member read offers and repositories; strangers see nothing", async () => {
    const s = await shop(2);
    const created = await offer(s, { items: ["sim_a"] });
    const member = await memberOf(s);
    expect(await listOffers(serviceContext(), member, s.slug)).toEqual([created]);
    expect(await listOfferableResources(serviceContext(), member, s.slug)).toEqual(
      s.resources.map((r) => ({
        id: r.id,
        name: r.nameSnapshot,
        private: true,
        archived: false,
        selection: "selected",
        sellable: true,
        accessLevels: ["write"],
      })),
    );
    const stranger = await signedUpUser();
    await expect(listOffers(serviceContext(), stranger, s.slug)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(listOfferableResources(serviceContext(), stranger, s.slug)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("reads capabilities it cannot parse as write-only, and marks removed repositories unsellable", async () => {
    const s = await shop(2);
    const [odd, removed] = s.resources;
    await env.DB.prepare("UPDATE resources SET capabilities = '{}' WHERE id = ?")
      .bind(odd?.id)
      .run();
    await env.DB.prepare("UPDATE resources SET selection = 'removed' WHERE id = ?")
      .bind(removed?.id)
      .run();
    const listed = await listOfferableResources(serviceContext(), s, s.slug);
    expect(listed.find((r) => r.id === odd?.id)).toMatchObject({
      sellable: true,
      accessLevels: ["write"],
    });
    expect(listed.find((r) => r.id === removed?.id)).toMatchObject({ sellable: false });
  });

  it("lists read access for repositories whose capabilities support it", async () => {
    const s = await shop();
    await env.DB.prepare(
      `UPDATE resources SET capabilities = json_set(capabilities, '$.readOnlyGrant', json('true')) WHERE id = ?`,
    )
      .bind(s.resources[0]?.id)
      .run();
    const [listed] = await listOfferableResources(serviceContext(), s, s.slug);
    expect(listed?.accessLevels).toEqual(["read", "write"]);
  });
});

describe("updateOffer", () => {
  it("writes a new version with the changes, audited, and queues a recompute", async () => {
    const s = await shop(2);
    const created = await offer(s, { items: ["sim_a"], resources: s.resources.slice(0, 1) });
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      updateOffer(ctx, s, s.slug, created.id, {
        name: "Pro+",
        gracePeriodDays: 7,
        items: [
          { source: "simulated", externalItemId: "sim_a" },
          { source: "simulated", externalItemId: "sim_b" },
        ],
        accesses: s.resources.map((r) => ({ resourceId: r.id, accessLevel: "write" })),
      }),
    );
    const { offer: updated, outboxId } = ok(result);
    expect(updated).toMatchObject({ name: "Pro+", version: 2, status: "active" });
    expect(updated.items).toHaveLength(2);
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      {
        action: "offer.updated",
        details: { version: 2, previousVersion: 1, changes: ["name", "items", "accesses"] },
      },
    ]);
    const work = await env.DB.prepare("SELECT kind, subject_id FROM outbox WHERE id = ?")
      .bind(outboxId)
      .first<{ kind: string; subject_id: string }>();
    expect(work?.kind).toBe("recompute_offer");
    expect(decodeOfferKey(work?.subject_id ?? "")).toEqual({
      ok: true,
      value: { workspaceId: s.workspaceId, offerId: created.id },
    });
    expect(await listOffers(serviceContext(), s, s.slug)).toEqual([updated]);
  });

  it("records a grace period change", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_g"], gracePeriodDays: 7 });
    const ctx = serviceContext();
    ok(
      await updateOffer(ctx, s, s.slug, created.id, {
        ...created,
        gracePeriodDays: 0,
      }),
    );
    const [event] = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(event?.details).toMatchObject({ changes: ["gracePeriodDays"] });
  });

  it("is a no-op for an unchanged configuration, given in any order", async () => {
    const s = await shop(2);
    const created = await offer(s, { items: ["sim_x", "sim_y"] });
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      updateOffer(ctx, s, s.slug, created.id, {
        name: created.name,
        gracePeriodDays: created.gracePeriodDays,
        items: [...created.items].reverse(),
        accesses: [...created.accesses].reverse(),
      }),
    );
    expect(result).toEqual({ ok: true, offer: created, outboxId: null });
    expect(changedTables).toEqual([]);
  });

  it("keeps a repository that stopped being sellable, but refuses adding one", async () => {
    const github = (await shop(2)).github;
    const s = await shop(2, github);
    const [kept, other] = s.resources;
    const created = await offer(s, { items: ["sim_k"], resources: [kept] as never });
    github.removeRepository(s.installationId, kept?.externalId ?? "");
    github.removeRepository(s.installationId, other?.externalId ?? "");
    await resyncConnection(serviceContext(), s.connection, github, "removed");
    ok(await updateOffer(serviceContext(), s, s.slug, created.id, { ...created, name: "Kept" }));
    await expect(
      updateOffer(serviceContext(), s, s.slug, created.id, {
        ...created,
        accesses: s.resources.map((r) => ({ resourceId: r.id, accessLevel: "write" })),
      }),
    ).resolves.toEqual({
      ok: false,
      errors: [{ field: "access", resourceId: other?.id, code: "resource_not_sellable" }],
    });
  });

  it("refuses invalid input and items another offer sells", async () => {
    const s = await shop();
    const first = await offer(s, { items: ["sim_one"] });
    const second = await offer(s, { items: ["sim_two"] });
    await expect(
      updateOffer(serviceContext(), s, s.slug, second.id, { ...second, gracePeriodDays: 31 }),
    ).resolves.toEqual({ ok: false, errors: [{ field: "input", code: "grace_period_invalid" }] });
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      updateOffer(ctx, s, s.slug, second.id, { ...second, items: first.items }),
    );
    expect(result).toEqual({ ok: false, errors: [{ field: "items", code: "item_taken" }] });
    expect(changedTables).toEqual([]);
  });

  it("is not found for an unknown offer and refused for an archived one", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_arch"] });
    await expect(
      updateOffer(serviceContext(), s, s.slug, "missing", created),
    ).rejects.toBeInstanceOf(NotFoundError);
    ok(await archiveOffer(serviceContext(), s, s.slug, created.id));
    await expect(updateOffer(serviceContext(), s, s.slug, created.id, created)).resolves.toEqual({
      ok: false,
      errors: [{ field: "offer", code: "offer_archived" }],
    });
  });

  it("is refused for members", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_m"] });
    const member = await memberOf(s);
    await expect(
      updateOffer(serviceContext(), member, s.slug, created.id, created),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(archiveOffer(serviceContext(), member, s.slug, created.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("raises a conflict for concurrent edits instead of applying both", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_c"] });
    const results = await Promise.allSettled([
      updateOffer(serviceContext(), s, s.slug, created.id, { ...created, name: "A" }),
      updateOffer(serviceContext(), s, s.slug, created.id, { ...created, name: "B" }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    const [listed] = await listOffers(serviceContext(), s, s.slug);
    expect(listed?.version).toBe(2);
  });

  it("propagates unexpected storage failures", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_f"] });
    await expect(
      updateOffer(failingBatches(), s, s.slug, created.id, { ...created, name: "X" }),
    ).rejects.toThrow("d1 down");
  });
});

describe("archiveOffer", () => {
  it("archives as a new version, audited, queues a recompute, and is idempotent", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_z"] });
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      archiveOffer(ctx, s, s.slug, created.id),
    );
    const archived = ok(result);
    expect(archived.offer).toMatchObject({ status: "archived", version: 2, items: created.items });
    expect(archived.outboxId).not.toBeNull();
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      { action: "offer.archived", details: { version: 2 } },
    ]);
    const again = serviceContext();
    const repeat = await expectAuditedChange(env.DB, again.correlationId, () =>
      archiveOffer(again, s, s.slug, created.id),
    );
    expect(repeat.result).toEqual({ ok: true, offer: archived.offer, outboxId: null });
    expect(repeat.changedTables).toEqual([]);
  });

  it("is not found for another workspace's offer", async () => {
    const s = await shop();
    const other = await shop();
    const created = await offer(other, { items: ["sim_o"] });
    await expect(archiveOffer(serviceContext(), s, s.slug, created.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
