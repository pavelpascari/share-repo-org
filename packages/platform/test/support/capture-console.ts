import { vi } from "vitest";

export type ConsoleMethod = "debug" | "info" | "warn" | "error" | "log";

export interface CapturedLine {
  readonly method: ConsoleMethod;
  readonly text: string;
}

export interface ConsoleCapture {
  readonly lines: CapturedLine[];
  /** Every captured line joined, for substring leak assertions. */
  text(): string;
  /** Captured lines parsed as JSON records. */
  records(): Record<string, unknown>[];
  restore(): void;
}

const methods: readonly ConsoleMethod[] = ["debug", "info", "warn", "error", "log"];

/** Replaces the global console methods and records everything written to them. */
export function captureConsole(): ConsoleCapture {
  const lines: CapturedLine[] = [];
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push({ method, text: args.map((arg) => String(arg)).join(" ") });
    }),
  );
  return {
    lines,
    text: () => lines.map((line) => line.text).join("\n"),
    records: () => lines.map((line) => JSON.parse(line.text) as Record<string, unknown>),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
