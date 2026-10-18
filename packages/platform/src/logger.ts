import { redact, redactString } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogContext extends LogFields {
  readonly correlationId: string;
  readonly workspaceId?: string;
}

export type LogSink = Readonly<Record<LogLevel, (line: string) => void>>;

export interface LoggerOptions {
  /** Epoch-millisecond clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Include redacted stack traces for Error values. Keep off in production. */
  readonly includeStacks?: boolean;
  /** Defaults to the global `console`, resolved on each call. */
  readonly sink?: LogSink;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Structured JSON-lines logger with key-based and pattern-based redaction. Never throws. */
export function createLogger(context: LogContext, options: LoggerOptions = {}): Logger {
  const now = options.now ?? Date.now;
  const includeStacks = options.includeStacks === true;

  const emit = (level: LogLevel, msg: string, fields: LogFields | undefined) => {
    let line: string;
    try {
      const reserved = {
        ts: new Date(now()).toISOString(),
        level,
        msg: redactString(msg),
        correlationId: context.correlationId,
      };
      // Reserved keys go first for readability and last so fields cannot forge them.
      line = JSON.stringify({
        ...reserved,
        ...(redact(context, { includeStacks }) as LogFields),
        ...(fields === undefined ? {} : (redact(fields, { includeStacks }) as LogFields)),
        ...reserved,
      });
    } catch {
      line = JSON.stringify({
        level,
        msg: "log serialisation failed",
        correlationId: String(context.correlationId),
      });
    }
    try {
      (options.sink ?? console)[level](line);
    } catch {
      // A failing sink must not break the caller.
    }
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) =>
      createLogger({ ...context, ...fields, correlationId: context.correlationId }, options),
  };
}
