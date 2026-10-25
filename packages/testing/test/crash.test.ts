import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { crashingD1, InjectedCrash } from "../src/index.ts";

// The crash-at-write-N helper over a real local D1 binding.

const count = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM crash_probe").first<{ n: number }>())?.n;

beforeAll(async () => {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS crash_probe (id INTEGER PRIMARY KEY)").run();
});

async function reset() {
  await env.DB.prepare("DELETE FROM crash_probe").run();
}

/** Two writes: a batch of two inserts, then a single insert; and reads in between. */
async function operation(d1: D1Database) {
  await d1.prepare("SELECT 1").first();
  await d1.batch([
    d1.prepare("INSERT INTO crash_probe (id) VALUES (?)").bind(1),
    d1.prepare("INSERT INTO crash_probe (id) VALUES (?)").bind(2),
  ]);
  await d1.prepare("SELECT count(*) FROM crash_probe").all();
  await d1.prepare("  insert into crash_probe (id) values (3)").run();
  return d1.prepare("SELECT count(*) AS n FROM crash_probe").first<{ n: number }>();
}

describe("crashingD1", () => {
  it("counts batches and single writes, never reads, and changes nothing without a plan", async () => {
    await reset();
    const counting = crashingD1(env.DB, null);
    expect(await operation(counting.binding)).toEqual({ n: 3 });
    expect(counting.writes).toBe(2);
    expect(counting.crashed).toBe(false);
  });

  it.each([
    [1, "before", 0],
    [1, "after", 2],
    [2, "before", 2],
    [2, "after", 3],
  ] as const)("write %i fails %s it runs, leaving %i rows", async (at, when, rows) => {
    await reset();
    const crashing = crashingD1(env.DB, { at, when });
    const error = await operation(crashing.binding).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InjectedCrash);
    expect(String(error)).toContain(`${when} write ${at}`);
    expect(crashing.crashed).toBe(true);
    expect(crashing.writes).toBe(at);
    expect(await count()).toBe(rows);
  });

  it("recognises a write after a common table expression", async () => {
    await reset();
    const crashing = crashingD1(env.DB, { at: 1, when: "before" });
    await expect(
      crashing.binding
        .prepare("WITH v(x) AS (SELECT 7) INSERT INTO crash_probe (id) SELECT x FROM v")
        .run(),
    ).rejects.toBeInstanceOf(InjectedCrash);
    expect(await count()).toBe(0);
    // A plain CTE read is not a write.
    const reading = crashingD1(env.DB, { at: 1, when: "before" });
    await reading.binding.prepare("WITH v(x) AS (SELECT 7) SELECT x FROM v").all();
    expect(reading.writes).toBe(0);
  });

  it("passes other properties of the binding and its statements through", async () => {
    const wrapped = crashingD1(env.DB, null).binding;
    const statement = wrapped.prepare("SELECT ? AS v").bind(5);
    expect(await statement.first("v")).toBe(5);
    expect(typeof wrapped.exec).toBe("function");
    // Properties that are not methods, on the binding and on a statement, read as they are.
    expect(Reflect.get(wrapped, "no_such_property")).toBeUndefined();
    expect(Reflect.get(statement, "no_such_property")).toBeUndefined();
    // A statement prepared on the plain binding is accepted in the wrapped binding's batch.
    await reset();
    await wrapped.batch([env.DB.prepare("INSERT INTO crash_probe (id) VALUES (9)")]);
    expect(await count()).toBe(1);
    expect(await wrapped.prepare("SELECT 1 AS one").raw()).toEqual([[1]]);
  });
});
