import { OUTBOX_KINDS } from "@sharerepo/domain";
import { z } from "zod";

/**
 * A message on the EVENTS queue: one outbox row, by ID (decision 0003). It carries identifiers
 * only; handlers re-read authoritative state. The web Worker sends the same shape.
 */
export const jobMessageSchema = z.strictObject({
  kind: z.enum(OUTBOX_KINDS),
  subjectId: z.string().min(1).max(128),
  outboxId: z.string().min(1).max(128),
});

export type JobMessage = z.output<typeof jobMessageSchema>;
