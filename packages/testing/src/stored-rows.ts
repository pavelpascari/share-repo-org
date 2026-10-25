/**
 * Stored-row secret scan (scenario `security/no-secrets-in-stored-rows-or-logs`): reads every
 * text value of every column of every application table, and finds secrets (as written, or hex
 * or base64 encoded) and email shapes in them.
 */

/** One stored text value: where it is, and the value itself (never put into a failure message). */
export interface StoredValue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
}

/** A secret or email found in a stored value, named without the value. */
export interface StoredFinding {
  readonly table: string;
  readonly column: string;
  /** `secret:<name>` for a secret, `email` for an email shape. */
  readonly kind: string;
}

/**
 * Email shapes: `local@domain.tld`, and the same with `@` percent-encoded, as it would be in a
 * stored URL. Global, so use with `match` or `matchAll`, never `test`.
 */
export const EMAIL_SHAPES: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,
];

/** Every email shape in `text`. */
export function emailShapes(text: string): string[] {
  return EMAIL_SHAPES.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/**
 * Application tables: everything but SQLite's own (`sqlite_*`), D1's migration bookkeeping
 * (`d1_*`) and Cloudflare's internal tables (`_cf_*`).
 */
export async function applicationTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name NOT LIKE 'd1\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

/**
 * Every text value stored in an application table, whatever its column's declared type (SQLite
 * stores any type in any column). Blobs are decoded as UTF-8.
 */
export async function readStoredText(db: D1Database): Promise<StoredValue[]> {
  const values: StoredValue[] = [];
  for (const table of await applicationTables(db)) {
    const { results: columns } = await db
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all<{ name: string }>();
    if (columns.length === 0) continue;
    const select = columns.map((column) => quote(column.name)).join(", ");
    const rows = await db.prepare(`SELECT ${select} FROM ${quote(table)}`).raw<unknown[]>();
    for (const row of rows) {
      for (const [index, cell] of row.entries()) {
        const column = (columns[index] as { name: string }).name;
        if (typeof cell === "string") values.push({ table, column, value: cell });
        else if (typeof cell === "object" && cell !== null) {
          // A blob: D1 returns its bytes as an array of numbers (or a buffer).
          const blob = new Uint8Array(cell as ArrayLike<number> | ArrayBuffer);
          values.push({ table, column, value: new TextDecoder().decode(blob) });
        }
      }
    }
  }
  return values;
}

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * The forms a secret could be stored in: as written, hex (either case), and base64 or base64url.
 * Base64 depends on where the secret starts within the encoded bytes, so each of the three
 * alignments contributes the part of its encoding that the secret alone determines.
 */
export function encodedForms(secret: string): string[] {
  const bytes = new TextEncoder().encode(secret);
  const hex = toHex(bytes);
  const forms = new Set([secret, hex, hex.toUpperCase()]);
  for (let offset = 0; offset < 3; offset += 1) {
    const shifted = new Uint8Array(offset + bytes.length);
    shifted.set(bytes, offset);
    const encoded = toBase64(shifted).replace(/=+$/, "");
    // Drop the group holding the padding bytes before, and the last (possibly partial) group.
    const core = encoded.slice(offset === 0 ? 0 : 4, encoded.length - 4);
    if (core.length >= 12) {
      forms.add(core);
      forms.add(core.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return [...forms];
}

/**
 * Every {@link encodedForms} of every secret, named `<name>` (as written) or `<name>#<n>`, for
 * `expectNoCanaryLeak`, whose failures then name the secret rather than print its value.
 */
export function encodedNeedles(
  secrets: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const needles: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    for (const [index, form] of encodedForms(value).entries()) {
      needles[index === 0 ? name : `${name}#${index}`] = form;
    }
  }
  return needles;
}

export interface StoredScanOptions {
  /** Secret values by name; each is searched for in every form of {@link encodedForms}. */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Whether an email shape found in a stored value is allowed there. Keep it narrow: a table,
   * a column, and an exact pattern. Defaults to allowing none.
   */
  readonly emailAllowed?: (stored: StoredValue, email: string) => boolean;
}

/** Every secret and disallowed email shape in the stored values, one finding per value and kind. */
export function scanStoredValues(
  values: readonly StoredValue[],
  options: StoredScanOptions,
): StoredFinding[] {
  const needles = Object.entries(options.secrets).map(
    ([name, value]) => [name, encodedForms(value)] as const,
  );
  for (const [name, forms] of needles) {
    if (forms[0] === "") throw new Error(`empty secret value for "${name}"`);
  }
  const allowed = options.emailAllowed ?? (() => false);
  const findings: StoredFinding[] = [];
  for (const stored of values) {
    for (const [name, forms] of needles) {
      if (forms.some((form) => stored.value.includes(form))) {
        findings.push({ table: stored.table, column: stored.column, kind: `secret:${name}` });
      }
    }
    if (emailShapes(stored.value).some((email) => !allowed(stored, email))) {
      findings.push({ table: stored.table, column: stored.column, kind: "email" });
    }
  }
  return findings;
}

/**
 * Reads every application table and fails if a secret or a disallowed email shape is stored
 * anywhere. The failure names tables, columns and secret names, never values. Returns what was
 * scanned, so a test can check that the scan saw the rows it seeded.
 */
export async function expectNoSecretsInStoredRows(
  db: D1Database,
  options: StoredScanOptions,
): Promise<{ readonly values: readonly StoredValue[] }> {
  const values = await readStoredText(db);
  const findings = scanStoredValues(values, options);
  if (findings.length > 0) {
    const unique = [...new Set(findings.map((f) => `  - ${f.kind} in ${f.table}.${f.column}`))];
    throw new Error(
      `${findings.length} stored secret or email finding(s):\n${unique.join("\n")}\n` +
        "Secrets must be sealed or never stored, and emails only sealed in their envelope.",
    );
  }
  return { values };
}
