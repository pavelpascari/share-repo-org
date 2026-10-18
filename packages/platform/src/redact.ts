export const REDACTED = "[REDACTED]";

const SENSITIVE_WORDS = [
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "signature",
  "credential",
  "session",
] as const;

/** Key names that end with one of these words are sensitive (`encryptionKey`, `jwt`). */
const SENSITIVE_SUFFIXES = ["jwt", "pem", "encryptionkey", "masterkey", "signingkey"] as const;

/** Key names that start with one of these words are sensitive (`accessKeyId`). */
const SENSITIVE_PREFIXES = ["accesskey"] as const;

const MAX_DEPTH = 10;

/** Strings are cut to this length before scanning, which bounds the cost of redaction. */
const MAX_STRING_LENGTH = 16_384;
const TRUNCATED = "[Truncated]";

/** Case-insensitive match, ignoring `-` and `_` (so `X-API-Key` matches `apikey`). */
export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, "");
  return (
    SENSITIVE_WORDS.some((word) => normalised.includes(word)) ||
    SENSITIVE_SUFFIXES.some((word) => normalised.endsWith(word)) ||
    SENSITIVE_PREFIXES.some((word) => normalised.startsWith(word))
  );
}

// Defence in depth for secrets embedded in free text; key-based redaction is the primary control.
// Every pattern must run in linear time: no unbounded quantifier may precede an alternation, and a
// lazy scan must always have a fallback that consumes the rest of the input.
const STRING_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // A key cut off before its END marker is redacted to the end of the string.
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
    REDACTED,
  ],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bpdl_[A-Za-z0-9_]{10,}/g, REDACTED],
];

// `key=value`, `key: value`, `"key":"value"`. A key is a whole run of key characters (the
// lookbehind gives each run one start, keeping the scan linear) and is judged by `isSensitiveKey`,
// so key length never limits redaction. Only the key and separator are consumed by this pattern,
// so a non-sensitive match such as `https:` does not hide a sensitive key later in a URL.
const KEY_SEPARATOR_SOURCE = String.raw`(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(["']?[ \t]*[:=][ \t]*["']?)`;
const VALUE_PATTERN = /(?:(?:bearer|basic)[ \t]+)?[^\s"'&,;]+/iy;

function redactKeyValues(input: string): string {
  const keySeparator = new RegExp(KEY_SEPARATOR_SOURCE, "g");
  let out = "";
  let copiedUpTo = 0;
  for (let match = keySeparator.exec(input); match !== null; match = keySeparator.exec(input)) {
    if (!isSensitiveKey(match[1] ?? "")) continue;
    const valueStart = match.index + match[0].length;
    VALUE_PATTERN.lastIndex = valueStart;
    const value = VALUE_PATTERN.exec(input);
    if (value === null) continue;
    out += `${input.slice(copiedUpTo, valueStart)}${REDACTED}`;
    copiedUpTo = valueStart + value[0].length;
    keySeparator.lastIndex = copiedUpTo;
  }
  return out + input.slice(copiedUpTo);
}

export function redactString(value: string): string {
  let out =
    value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : value;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return redactKeyValues(out);
}

export interface RedactOptions {
  /** Include (redacted) stack traces for Error values. Off by default. */
  readonly includeStacks?: boolean;
}

/**
 * Returns a JSON-safe copy of `value` with sensitive keys replaced by `[REDACTED]` at any
 * depth, secret-looking substrings scrubbed, Errors reduced to name/message, and cycles
 * marked `[Circular]`. May throw if a getter throws; callers that must not throw catch.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return visit(value, [], options.includeStacks === true);
}

function visit(value: unknown, ancestors: object[], includeStacks: boolean): unknown {
  switch (typeof value) {
    case "string":
      return redactString(value);
    case "bigint":
      return value.toString();
    case "function":
      return "[Function]";
    case "symbol":
      return value.toString();
    case "object":
      break;
    default:
      return value;
  }
  if (value === null) return null;
  if (ancestors.includes(value)) return "[Circular]";
  if (ancestors.length >= MAX_DEPTH) return "[Truncated]";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof URL) return redactString(value.href);

  const path = [...ancestors, value];
  const child = (inner: unknown) => visit(inner, path, includeStacks);

  if (value instanceof Error) return serialiseError(value, child, includeStacks);
  if (Array.isArray(value)) return value.map(child);
  if (value instanceof Set) return [...value].map(child);
  if (value instanceof Map || value instanceof Headers) {
    return redactEntries([...value.entries()], child);
  }
  return redactEntries(Object.entries(value), child);
}

function redactEntries(
  entries: Iterable<readonly [unknown, unknown]>,
  child: (inner: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, inner] of entries) {
    const key = String(rawKey);
    out[key] = isSensitiveKey(key) ? REDACTED : child(inner);
  }
  return out;
}

function serialiseError(
  error: Error,
  child: (inner: unknown) => unknown,
  includeStacks: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: redactString(String(error.name)),
    message: redactString(String(error.message)),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") out.code = redactString(code);
  if (includeStacks && typeof error.stack === "string") out.stack = redactString(error.stack);
  if (error.cause !== undefined) out.cause = child(error.cause);
  return out;
}
