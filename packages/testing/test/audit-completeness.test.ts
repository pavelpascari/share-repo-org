import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  changedTables,
  expectAuditedChange,
  expectNoChangeOnFailure,
  snapshotTables,
  UNAUDITED_TABLES,
} from "../src/index.ts";

const db = env.DB;
let correlation = 0;
const nextCorrelationId = () => `corr-${++correlation}`;

beforeAll(async () => {
  await db.batch([
    db.prepare("CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL)"),
    db.prepare("CREATE TABLE audit_events (id INTEGER PRIMARY KEY, correlation_id TEXT NOT NULL)"),
    db.prepare("CREATE TABLE auth_sessions (id TEXT PRIMARY KEY)"),
  ]);
});

const insertThing = (id: string) =>
  db.prepare("INSERT INTO things (id, name) VALUES (?, 'x')").bind(id);
const audit = (correlationId: string) =>
  db.prepare("INSERT INTO audit_events (correlation_id) VALUES (?)").bind(correlationId);

describe("snapshotTables", () => {
  it("skips unaudited tables and is independent of row order", async () => {
    const snapshot = await snapshotTables(db);
    expect([...snapshot.keys()]).toEqual(["things"]);
    await db.batch([insertThing("b"), insertThing("a")]);
    const one = await snapshotTables(db);
    await db.prepare("DELETE FROM things").run();
    await db.batch([insertThing("a"), insertThing("b")]);
    expect(await snapshotTables(db)).toEqual(one);
  });

  it("accepts a custom ignore list", async () => {
    const snapshot = await snapshotTables(db, {});
    expect([...snapshot.keys()]).toEqual(["audit_events", "auth_sessions", "things"]);
  });

  it("documents why each default table is unaudited", () => {
    for (const reason of Object.values(UNAUDITED_TABLES)) expect(reason.length).toBeGreaterThan(5);
  });
});

describe("changedTables", () => {
  it("reports changed, added and dropped tables in order", () => {
    const before = new Map([
      ["a", "1"],
      ["b", "1"],
      ["c", "1"],
    ]);
    const after = new Map([
      ["a", "1"],
      ["c", "2"],
      ["d", "1"],
    ]);
    expect(changedTables(before, after)).toEqual(["b", "c", "d"]);
  });
});

describe("expectAuditedChange", () => {
  it("passes when a change has an audit event with the correlation ID", async () => {
    const id = nextCorrelationId();
    const outcome = await expectAuditedChange(db, id, async () => {
      await db.batch([insertThing(id), audit(id)]);
      return "done";
    });
    expect(outcome).toEqual({ result: "done", changedTables: ["things"], auditEventCount: 1 });
  });

  it("fails when a change has no audit event", async () => {
    const id = nextCorrelationId();
    await expect(
      expectAuditedChange(db, id, async () => {
        await insertThing(id).run();
      }),
    ).rejects.toThrow(`State changed in things without an audit event for correlation ID ${id}`);
  });

  it("does not accept an audit event with another correlation ID", async () => {
    const id = nextCorrelationId();
    await expect(
      expectAuditedChange(db, id, () => db.batch([insertThing(id), audit("other")])),
    ).rejects.toThrow("without an audit event");
  });

  it("passes when nothing audited changed, even with an audit event", async () => {
    const id = nextCorrelationId();
    const outcome = await expectAuditedChange(db, id, async () => {
      await db.batch([db.prepare("INSERT INTO auth_sessions (id) VALUES (?)").bind(id), audit(id)]);
    });
    expect(outcome.changedTables).toEqual([]);
    expect(outcome.auditEventCount).toBe(1);
  });

  it("honours a custom ignore list", async () => {
    const id = nextCorrelationId();
    const outcome = await expectAuditedChange(db, id, () => insertThing(id).run(), {
      ...UNAUDITED_TABLES,
      things: "test",
    });
    expect(outcome.changedTables).toEqual([]);
  });
});

describe("expectNoChangeOnFailure", () => {
  it("returns the rejection when nothing changed", async () => {
    const error = new Error("nope");
    await expect(expectNoChangeOnFailure(db, () => Promise.reject(error))).resolves.toBe(error);
  });

  it("fails when the operation succeeds", async () => {
    await expect(expectNoChangeOnFailure(db, async () => undefined)).rejects.toThrow(
      "Expected the operation to fail, but it succeeded",
    );
  });

  it("fails when a failed operation changed a table", async () => {
    const id = nextCorrelationId();
    await expect(
      expectNoChangeOnFailure(db, async () => {
        await insertThing(id).run();
        throw new Error("late failure");
      }),
    ).rejects.toThrow("A failed operation changed things");
  });

  it("fails when a failed operation wrote an audit event", async () => {
    const id = nextCorrelationId();
    await expect(
      expectNoChangeOnFailure(db, async () => {
        await audit(id).run();
        throw new Error("late failure");
      }),
    ).rejects.toThrow("A failed operation wrote audit events");
  });

  it("honours a custom ignore list", async () => {
    const id = nextCorrelationId();
    await expect(
      expectNoChangeOnFailure(
        db,
        async () => {
          await insertThing(id).run();
          throw new Error("late failure");
        },
        { ...UNAUDITED_TABLES, things: "test" },
      ),
    ).resolves.toBeInstanceOf(Error);
  });
});
