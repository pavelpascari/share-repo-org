/** Source of new identifiers. Injected so tests can use deterministic sequences. */
export interface IdGenerator {
  next(): string;
}

export const randomIds: IdGenerator = {
  next: () => crypto.randomUUID(),
};
