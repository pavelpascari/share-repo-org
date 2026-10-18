import { formatLogArgs } from "./format.ts";

export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface CapturedLog {
  level: ConsoleLevel;
  args: unknown[];
  line: string;
}

export interface LogCapture extends Disposable {
  readonly entries: readonly CapturedLog[];
  lines(): string[];
  /** All captured lines joined with trailing newlines. */
  text(): string;
  clear(): void;
  /** Puts the original console methods back. Safe to call more than once. */
  restore(): void;
}

/**
 * Replaces console methods with recorders until `restore()` is called. Output is not
 * forwarded, so tests stay quiet. Use with `using`, or call `restore()` in `afterEach`.
 */
export function captureLogs(): LogCapture {
  const entries: CapturedLog[] = [];
  // Restore own property descriptors rather than re-assigning values: in workerd, reading a
  // console method returns a freshly bound function each time.
  const originals = new Map<ConsoleLevel, PropertyDescriptor | undefined>();
  for (const level of CONSOLE_LEVELS) {
    originals.set(level, Object.getOwnPropertyDescriptor(console, level));
    console[level] = (...args: unknown[]) => {
      entries.push({ level, args, line: formatLogArgs(args) });
    };
  }

  const restore = () => {
    for (const [level, descriptor] of originals) {
      if (descriptor) Object.defineProperty(console, level, descriptor);
      else Reflect.deleteProperty(console, level);
    }
    originals.clear();
  };

  return {
    entries,
    lines: () => entries.map((entry) => entry.line),
    text: () => entries.map((entry) => `${entry.line}\n`).join(""),
    clear: () => {
      entries.length = 0;
    },
    restore,
    [Symbol.dispose]: restore,
  };
}
