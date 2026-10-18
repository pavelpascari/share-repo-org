/** A UTC instant in epoch milliseconds. Storage and policy always use UTC. */
export type Instant = number;

/** Source of the current time. Injected so time-dependent policy is testable. */
export interface Clock {
  now(): Instant;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
