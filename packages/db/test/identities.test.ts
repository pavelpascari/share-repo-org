import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createDb,
  type ExternalIdentity,
  findExternalIdentity,
  findExternalIdentityForUser,
  insertExternalIdentity,
  listAuditEventsByCorrelationId,
  updateExternalIdentitySnapshot,
} from "../src/index.ts";
import { accountEvent, auditCount } from "./support/audit.ts";
import { insertUserRow, T0, uniqueId } from "./support/rows.ts";

const db = createDb(env.DB);

let nextGitHubId = 1_000;
const githubUserId = () => String(nextGitHubId++);

async function newUserId() {
  const id = uniqueId("usr");
  await insertUserRow(id);
  return id;
}

function identity(userId: string, overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    id: uniqueId("idn"),
    userId,
    provider: "github",
    externalUserId: githubUserId(),
    usernameSnapshot: "octocat",
    displayNameSnapshot: "The Octocat",
    avatarUrlSnapshot: "https://avatars.githubusercontent.com/u/1",
    verifiedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

async function linked(userId: string, overrides: Partial<ExternalIdentity> = {}) {
  const value = identity(userId, overrides);
  const result = await insertExternalIdentity(db, value, [accountEvent()]);
  if (!result.ok) throw new Error(result.reason);
  return value;
}

describe("insertExternalIdentity", () => {
  it("stores the identity and its audit events together", async () => {
    const userId = await newUserId();
    const value = identity(userId, { displayNameSnapshot: null, avatarUrlSnapshot: null });
    const event = accountEvent({ action: "identity.linked" });

    await expect(insertExternalIdentity(db, value, [event])).resolves.toEqual({
      ok: true,
      identity: value,
    });
    await expect(
      findExternalIdentity(db, { provider: "github", externalUserId: value.externalUserId }),
    ).resolves.toEqual(value);
    await expect(listAuditEventsByCorrelationId(db, event.correlationId)).resolves.toEqual([event]);
  });

  it("reports identity_taken when the provider account is linked to another user", async () => {
    const first = await linked(await newUserId());
    const event = accountEvent();
    const result = await insertExternalIdentity(
      db,
      identity(await newUserId(), { externalUserId: first.externalUserId }),
      [event],
    );
    expect(result).toEqual({ ok: false, reason: "identity_taken" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("reports user_already_linked when the user has an identity for the provider", async () => {
    const userId = await newUserId();
    await linked(userId);
    const event = accountEvent();
    const result = await insertExternalIdentity(db, identity(userId), [event]);
    expect(result).toEqual({ ok: false, reason: "user_already_linked" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("propagates other constraint errors, such as an unknown user", async () => {
    const event = accountEvent();
    await expect(
      insertExternalIdentity(db, identity(uniqueId("missing")), [event]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("propagates an id collision instead of misreporting it", async () => {
    const existing = await linked(await newUserId());
    await expect(
      insertExternalIdentity(db, identity(await newUserId(), { id: existing.id }), [
        accountEvent(),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed: external_identities.id/);
  });

  it("writes nothing when an audit event is invalid", async () => {
    const userId = await newUserId();
    const value = identity(userId);
    await expect(
      insertExternalIdentity(db, value, [accountEvent({ workspaceId: uniqueId("ws") })]),
    ).rejects.toThrow(/CHECK constraint/);
    await expect(
      findExternalIdentityForUser(db, { userId, provider: "github" }),
    ).resolves.toBeNull();
  });
});

describe("find helpers", () => {
  it("find by provider account and by user return the same identity", async () => {
    const userId = await newUserId();
    const value = await linked(userId);
    await expect(
      findExternalIdentity(db, { provider: "github", externalUserId: value.externalUserId }),
    ).resolves.toEqual(value);
    await expect(findExternalIdentityForUser(db, { userId, provider: "github" })).resolves.toEqual(
      value,
    );
  });

  it("return null when nothing matches", async () => {
    await expect(
      findExternalIdentity(db, { provider: "github", externalUserId: "999999999" }),
    ).resolves.toBeNull();
    await expect(
      findExternalIdentityForUser(db, { userId: await newUserId(), provider: "github" }),
    ).resolves.toBeNull();
  });
});

describe("updateExternalIdentitySnapshot", () => {
  it("updates the snapshot in place after a username change and audits it", async () => {
    const userId = await newUserId();
    const value = await linked(userId);
    const event = accountEvent({ action: "identity.snapshot_updated" });

    const result = await updateExternalIdentitySnapshot(
      db,
      {
        id: value.id,
        userId,
        usernameSnapshot: "octocat-renamed",
        displayNameSnapshot: null,
        avatarUrlSnapshot: null,
        verifiedAt: T0 + 5,
        now: T0 + 5,
      },
      [event],
    );

    expect(result).toEqual({ ok: true });
    await expect(
      findExternalIdentity(db, { provider: "github", externalUserId: value.externalUserId }),
    ).resolves.toEqual({
      ...value,
      usernameSnapshot: "octocat-renamed",
      displayNameSnapshot: null,
      avatarUrlSnapshot: null,
      verifiedAt: T0 + 5,
      updatedAt: T0 + 5,
    });
    await expect(listAuditEventsByCorrelationId(db, event.correlationId)).resolves.toEqual([event]);
  });

  it("refuses another user's identity and writes no audit row", async () => {
    const owner = await newUserId();
    const value = await linked(owner);
    const event = accountEvent();

    const result = await updateExternalIdentitySnapshot(
      db,
      {
        id: value.id,
        userId: await newUserId(),
        usernameSnapshot: "hijacked",
        displayNameSnapshot: null,
        avatarUrlSnapshot: null,
        verifiedAt: T0 + 1,
        now: T0 + 1,
      },
      [event],
    );

    expect(result).toEqual({ ok: false, reason: "identity_not_owned" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    await expect(
      findExternalIdentityForUser(db, { userId: owner, provider: "github" }),
    ).resolves.toEqual(value);
  });

  it("refuses an unknown identity and writes no audit row", async () => {
    const event = accountEvent();
    const result = await updateExternalIdentitySnapshot(
      db,
      {
        id: uniqueId("idn"),
        userId: await newUserId(),
        usernameSnapshot: "nobody",
        displayNameSnapshot: null,
        avatarUrlSnapshot: null,
        verifiedAt: T0,
        now: T0,
      },
      [event],
    );
    expect(result).toEqual({ ok: false, reason: "identity_not_owned" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("external_identities constraints", () => {
  function insertRaw(overrides: Record<string, unknown>) {
    const r = {
      id: uniqueId("idn"),
      provider: "github",
      external_user_id: githubUserId(),
      username_snapshot: "octocat",
      created_at: T0,
      updated_at: T0,
      ...overrides,
    };
    return env.DB.prepare(
      `INSERT INTO external_identities (id, user_id, provider, external_user_id, username_snapshot,
         verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        r.id,
        r.user_id,
        r.provider,
        r.external_user_id,
        r.username_snapshot,
        T0,
        r.created_at,
        r.updated_at,
      )
      .run();
  }

  it("rejects an unknown provider", async () => {
    await expect(insertRaw({ user_id: await newUserId(), provider: "gitlab" })).rejects.toThrow(
      /external_identities_provider_valid/,
    );
  });

  it("rejects an empty external user id", async () => {
    await expect(insertRaw({ user_id: await newUserId(), external_user_id: "" })).rejects.toThrow(
      /external_identities_external_user_id_present/,
    );
  });

  it("rejects an empty username snapshot", async () => {
    await expect(insertRaw({ user_id: await newUserId(), username_snapshot: "" })).rejects.toThrow(
      /external_identities_username_present/,
    );
  });

  it("rejects updated_at before created_at", async () => {
    await expect(
      insertRaw({ user_id: await newUserId(), created_at: T0 + 1, updated_at: T0 }),
    ).rejects.toThrow(/external_identities_updated_after_created/);
  });

  it("enforces both uniqueness rules at the database level", async () => {
    const userId = await newUserId();
    await insertRaw({ user_id: userId, external_user_id: "42" });
    await expect(insertRaw({ user_id: await newUserId(), external_user_id: "42" })).rejects.toThrow(
      /UNIQUE constraint failed: external_identities.provider, external_identities.external_user_id/,
    );
    await expect(insertRaw({ user_id: userId })).rejects.toThrow(
      /UNIQUE constraint failed: external_identities.user_id, external_identities.provider/,
    );
  });
});
