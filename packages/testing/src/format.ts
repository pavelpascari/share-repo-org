/** Formats console arguments like a log line: strings verbatim, everything else as safe JSON. */
export function formatLogArgs(args: readonly unknown[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : safeStringify(arg))).join(" ");
}

/** JSON-like serialisation that never throws: handles cycles, bigints, errors, and symbols. */
export function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;

  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") return `${current}n`;
    if (typeof current === "symbol") return current.toString();
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
    if (current instanceof Error) {
      return { name: current.name, message: current.message, stack: current.stack };
    }
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  });
}
