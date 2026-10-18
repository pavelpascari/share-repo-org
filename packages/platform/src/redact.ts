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

const MAX_DEPTH = 10;

/** Case-insensitive substring match, ignoring `-` and `_` (so `X-API-Key` matches `apikey`). */
export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_WORDS.some((word) => normalised.includes(word));
}

const SENSITIVE_KEY_SOURCE =
  "[A-Za-z0-9_-]*(?:token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|signature|credential|session)[A-Za-z0-9_-]*";

// Defence in depth for secrets embedded in free text; key-based redaction is the primary control.
const STRING_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // `key=value`, `key: value`, `"key":"value"`, including an optional auth scheme.
  [
    new RegExp(
      `(${SENSITIVE_KEY_SOURCE})(["']?\\s*[:=]\\s*["']?)(?:(?:bearer|basic)\\s+)?[^\\s"'&,;]+`,
      "gi",
    ),
    `$1$2${REDACTED}`,
  ],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bpdl_[A-Za-z0-9_]{10,}/g, REDACTED],
];

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
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
