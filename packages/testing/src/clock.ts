import type { Clock, Instant } from "@sharerepo/domain";

/** A fixed, recognisable default start so tests never depend on the real date. */
export const DEFAULT_FAKE_NOW: Instant = Date.UTC(2026, 0, 1);

/** A controllable `Clock`. Time only moves when a test calls `set` or `advance`. */
export class FakeClock implements Clock {
  #now: Instant;

  constructor(start: Instant | Date | string = DEFAULT_FAKE_NOW) {
    this.#now = toInstant(start);
  }

  now(): Instant {
    return this.#now;
  }

  set(instant: Instant | Date | string): void {
    this.#now = toInstant(instant);
  }

  /** Moves time forward by `ms` and returns the new instant. */
  advance(ms: number): Instant {
    if (!Number.isFinite(ms)) throw new RangeError(`advance(ms) needs a finite number, got ${ms}`);
    if (ms < 0) throw new RangeError(`advance(ms) needs a non-negative number, got ${ms}`);
    this.#now += ms;
    return this.#now;
  }
}

function toInstant(value: Instant | Date | string): Instant {
  const ms =
    typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(ms)) throw new RangeError(`invalid instant: ${String(value)}`);
  return ms;
}
