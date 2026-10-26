import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applicationTables,
  emailShapes,
  encodedForms,
  encodedNeedles,
  expectNoSecretsInStoredRows,
  readStoredText,
  scanStoredValues,
} from "../src/index.ts";

const db = env.DB;
const SECRET = "SRCANARY_STORED_0123456789abcdef";
const TABLE = 'rows "quoted"';

beforeAll(async () => {
  await db.batch([
    db.prepare('CREATE TABLE "rows ""quoted""" (id INTEGER PRIMARY KEY, note TEXT, data BLOB)'),
    db.prepare("CREATE TABLE d1_bookkeeping (value TEXT)"),
    db.prepare("INSERT INTO d1_bookkeeping (value) VALUES (?)").bind(SECRET),
  ]);
});

const bytes = (text: string) => new TextEncoder().encode(text);
const insert = (note: string | number | null, data: Uint8Array | null = null) =>
  db.prepare('INSERT INTO "rows ""quoted""" (note, data) VALUES (?, ?)').bind(note, data).run();
const clear = () => db.prepare('DELETE FROM "rows ""quoted"""').run();

describe("readStoredText", () => {
  it("reads every text and blob value of the application tables only", async () => {
    await clear();
    await insert("plain", bytes("blob text"));
    await insert(null);
    expect(await applicationTables(db)).toEqual([TABLE]);
    expect(await readStoredText(db)).toEqual([
      { table: TABLE, column: "note", value: "plain" },
      { table: TABLE, column: "data", value: "blob text" },
    ]);
  });
});

describe("encodedForms", () => {
  it("covers hex and base64 at every alignment", () => {
    const forms = encodedForms(SECRET);
    expect(forms).toContain(SECRET);
    for (const prefix of ["", "x", "xy"]) {
      const encoded = btoa(`${prefix}${SECRET}!`);
      expect(forms.some((form) => encoded.includes(form))).toBe(true);
      const url = encoded.replaceAll("+", "-").replaceAll("/", "_");
      expect(forms.some((form) => url.includes(form))).toBe(true);
    }
    const hex = [...bytes(SECRET)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(forms).toEqual(expect.arrayContaining([hex, hex.toUpperCase()]));
    // Too short for a base64 core: only the plain and hex forms.
    expect(encodedForms("ab")).toEqual(["ab", "6162"]);
  });
});

describe("encodedNeedles", () => {
  it("names every form after its secret", () => {
    expect(encodedNeedles({ short: "ab" })).toEqual({ short: "ab", "short#1": "6162" });
  });
});

describe("scanStoredValues", () => {
  const at = (value: string) => ({ table: "t", column: "c", value });

  it("finds secrets in any form and disallowed email shapes, naming no value", () => {
    const findings = scanStoredValues(
      [
        at(`x${SECRET}`),
        at(btoa(`{"k":"${SECRET}"}`)),
        at("mail buyer@example.com"),
        at("https://pay.test/?email=buyer%40example.com"),
        at("github-1@users.sharerepo.invalid"),
        at("nothing here"),
      ],
      {
        secrets: { stored: SECRET },
        emailAllowed: (_stored, email) => email.endsWith("@users.sharerepo.invalid"),
      },
    );
    expect(findings).toEqual([
      { table: "t", column: "c", kind: "secret:stored" },
      { table: "t", column: "c", kind: "secret:stored" },
      { table: "t", column: "c", kind: "email" },
      { table: "t", column: "c", kind: "email" },
    ]);
    expect(scanStoredValues([at("a@b.example")], { secrets: {} })).toHaveLength(1);
  });

  it("refuses an empty secret", () => {
    expect(() => scanStoredValues([], { secrets: { none: "" } })).toThrow(/empty secret/);
  });
});

describe("emailShapes", () => {
  it("finds plain and percent-encoded addresses", () => {
    expect(emailShapes("a a.b@c.example d%40e.example")).toEqual([
      "a.b@c.example",
      "d%40e.example",
    ]);
  });
});

describe("expectNoSecretsInStoredRows", () => {
  it("passes on clean rows and fails naming the table and column only", async () => {
    await clear();
    await insert("clean");
    const { values } = await expectNoSecretsInStoredRows(db, { secrets: { stored: SECRET } });
    expect(values).toHaveLength(1);
    await insert(null, bytes(SECRET));
    const failure = await expectNoSecretsInStoredRows(db, { secrets: { stored: SECRET } }).catch(
      (error: Error) => error.message,
    );
    expect(failure).toContain(`secret:stored in ${TABLE}.data`);
    expect(failure).not.toContain(SECRET);
  });
});
