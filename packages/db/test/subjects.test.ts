import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  findCustomer,
  findSubjectByExternalId,
  getCustomer,
  insertSubject,
  isUniqueViolation,
  listGrantsForWorkspace,
  listSubjects,
  schema,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import { subjectRow, subscribedWorkspace } from "./support/commerce.ts";
import { db, workspaceWithOwner } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

describe("subjects", () => {
  it("inserts with audit and finds by external ID within the workspace", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const other = await workspaceWithOwner();
    const subject = subjectRow(workspaceId);
    const event = workspaceEvent(workspaceId);
    await insertSubject(db, subject, [event]);
    const key = {
      workspaceId,
      provider: "github" as const,
      externalSubjectId: subject.externalSubjectId,
    };
    expect(await findSubjectByExternalId(db, key)).toEqual(subject);
    expect(
      await findSubjectByExternalId(db, { ...key, workspaceId: other.workspaceId }),
    ).toBeNull();
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("surfaces a duplicate external ID as a unique violation, writing nothing", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const subject = subjectRow(workspaceId);
    await insertSubject(db, subject, [workspaceEvent(workspaceId)]);
    const event = workspaceEvent(workspaceId);
    const error = await insertSubject(
      db,
      subjectRow(workspaceId, { externalSubjectId: subject.externalSubjectId }),
      [event],
    ).catch((e: unknown) => e);
    expect(
      isUniqueViolation(error, [
        "subjects.workspace_id",
        "subjects.provider",
        "subjects.external_subject_id",
      ]),
    ).toBe(true);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("lists by login, ignoring IDs of other workspaces", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const other = await workspaceWithOwner();
    const zed = subjectRow(workspaceId, { loginSnapshot: "zed" });
    const amy = subjectRow(workspaceId, { loginSnapshot: "amy" });
    const theirs = subjectRow(other.workspaceId);
    for (const subject of [zed, amy, theirs]) {
      await insertSubject(db, subject, [workspaceEvent(subject.workspaceId)]);
    }
    expect(
      await listSubjects(db, { workspaceId, ids: [zed.id, amy.id, theirs.id, uniqueId("sub")] }),
    ).toEqual([amy, zed]);
    expect(await listSubjects(db, { workspaceId, ids: [] })).toEqual([]);
  });
});

describe("customers", () => {
  it("finds by external ID or ID, scoped to the workspace and source", async () => {
    const ws = await subscribedWorkspace();
    const other = await workspaceWithOwner();
    const key = {
      workspaceId: ws.workspaceId,
      source: "simulated" as const,
      externalCustomerId: ws.customer.externalCustomerId,
    };
    expect(await findCustomer(db, key)).toEqual(ws.customer);
    expect(await findCustomer(db, { ...key, source: "paddle" })).toBeNull();
    expect(await findCustomer(db, { ...key, workspaceId: other.workspaceId })).toBeNull();
    expect(
      await getCustomer(db, { workspaceId: other.workspaceId, customerId: ws.customer.id }),
    ).toBeNull();
  });
});

describe("grants", () => {
  it("lists the workspace's grants, oldest first", async () => {
    const ws = await subscribedWorkspace();
    const other = await subscribedWorkspace();
    const grant = (
      w: typeof ws,
      overrides: Partial<typeof schema.grants.$inferSelect> = {},
    ): typeof schema.grants.$inferSelect => ({
      id: uniqueId("gra"),
      workspaceId: w.workspaceId,
      connectionId: w.connection.id,
      subjectId: w.subject.id,
      resourceId: w.resource.id,
      accessLevel: "write",
      state: "unknown",
      managed: false,
      entitlementId: null,
      externalGrantId: null,
      expiresAt: null,
      observedAt: null,
      lastAttemptAt: null,
      lastErrorCode: null,
      retryClass: null,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });
    const later = grant(ws, { createdAt: T0 + 1, updatedAt: T0 + 1, accessLevel: "read" });
    const earlier = grant(ws, { managed: true, entitlementId: ws.entitlement.id });
    for (const row of [later, earlier, grant(other)]) await db.insert(schema.grants).values(row);
    expect(await listGrantsForWorkspace(db, ws.workspaceId)).toEqual([earlier, later]);
  });
});
