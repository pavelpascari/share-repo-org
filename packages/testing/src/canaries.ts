import { captureLogs, type LogCapture } from "./logs.ts";

/** Every canary starts with this marker, so a leak is recognisable in any output. */
export const CANARY_PREFIX = "SRCANARY";

export type SecretCanaries<Name extends string = string> = Readonly<Record<Name, string>>;

/**
 * Creates one unique, recognisable fake secret per name. Values use only `[A-Z0-9_a-f]`,
 * so they pass through JSON, URL, and header encoding unchanged and stay searchable.
 */
export function createSecretCanaries<const Name extends string>(
  names: readonly Name[],
): SecretCanaries<Name> {
  const canaries: Partial<Record<Name, string>> = {};
  for (const name of names) {
    if (name === "") throw new Error("secret canary names must not be empty");
    if (name in canaries) throw new Error(`duplicate secret canary name: ${name}`);
    const label = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    canaries[name] = `${CANARY_PREFIX}_${label}_${nonce}`;
  }
  return canaries as SecretCanaries<Name>;
}

interface Leak {
  name: string;
  path: string;
}

type CanaryInput = SecretCanaries | readonly string[];

/**
 * Fails if any canary appears anywhere in `haystack`: strings, object keys and values at any
 * depth, errors (message, stack, cause, own properties), maps, sets, iterables, and byte
 * buffers. Pass captured log entries, audit details, stored payloads, or error messages.
 * The failure message names the canary and where it was found, never its value.
 */
export function expectNoCanaryLeak(haystack: unknown, canaries: CanaryInput): void {
  throwOnLeaks([[haystack, ""]], toEntries(canaries));
}

/**
 * Runs `fn` with fresh canaries and captured console output, then fails if a canary leaked
 * into the logs, the returned value, or a thrown error. The console is always restored.
 */
export async function withSecretCanaries<const Name extends string, T>(
  names: readonly Name[],
  fn: (canaries: SecretCanaries<Name>, logs: LogCapture) => T | Promise<T>,
): Promise<T> {
  const canaries = createSecretCanaries(names);
  const logs = captureLogs();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn(canaries, logs) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    logs.restore();
  }
  throwOnLeaks(
    [
      [logs.entries, "<logs>"],
      outcome.ok ? [outcome.value, "<result>"] : [outcome.error, "<thrown>"],
    ],
    toEntries(canaries),
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function toEntries(canaries: CanaryInput): Array<[name: string, value: string]> {
  const entries: Array<[string, string]> = Array.isArray(canaries)
    ? canaries.map((value: string) => [value, value])
    : Object.entries(canaries);
  for (const [name, value] of entries) {
    if (value === "") throw new Error(`empty canary value for "${name}"`);
  }
  return entries;
}

function throwOnLeaks(
  roots: ReadonlyArray<readonly [unknown, string]>,
  canaries: ReadonlyArray<[string, string]>,
): void {
  const leaks: Leak[] = [];
  const seen = new WeakSet<object>();
  const check = (text: string, path: string) => {
    for (const [name, value] of canaries) {
      if (text.includes(value)) leaks.push({ name, path: path || "<root>" });
    }
  };

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") check(value, path);
    else if (typeof value === "symbol") check(value.description ?? "", path);
    else if (typeof value === "function") check(value.name, path);
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      check(new TextDecoder().decode(value), `${path}<bytes>`);
      return;
    }
    if (value instanceof Map) {
      for (const [key, item] of value) {
        walk(key, `${path}<map key>`);
        walk(item, `${path}<map value>`);
      }
      return;
    }
    if (value instanceof Set) {
      for (const item of value) walk(item, `${path}<set>`);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`);
      return;
    }
    if (value instanceof Error) {
      walk(value.name, `${path}.name`);
      walk(value.message, `${path}.message`);
      walk(value.stack, `${path}.stack`);
      walk(value.cause, `${path}.cause`);
    } else if (Symbol.iterator in value) {
      let index = 0;
      for (const item of value as Iterable<unknown>) walk(item, `${path}[${index++}]`);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null && !(value instanceof Error)) {
      // URL, Request, and similar objects expose their data through toString.
      check(String(value), `${path}<string>`);
    }
    for (const [key, item] of Object.entries(value)) {
      check(key, `${path}.<key>`);
      walk(item, `${path}.${key}`);
    }
  };

  for (const [root, path] of roots) walk(root, path);
  if (leaks.length === 0) return;

  const mask = (text: string) =>
    canaries.reduce((acc, [name, value]) => acc.replaceAll(value, `<canary:${name}>`), text);
  const details = leaks.map((leak) => `  - canary "${leak.name}" leaked at ${mask(leak.path)}`);
  throw new Error(
    `${leaks.length} secret canary leak(s) found:\n${details.join("\n")}\n` +
      "Secrets must be redacted before they reach logs, errors, audit details, or stored payloads.",
  );
}
