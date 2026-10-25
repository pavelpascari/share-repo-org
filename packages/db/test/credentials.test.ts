import { describe, expect, it } from "vitest";
import {
  countEnvelopesUnderKeys,
  listEnvelopesUnderKeys,
  rewrapClaimRequestEmail,
  schema,
} from "../src/index.ts";
import { db, workspaceWithOwner } from "./support/connections.ts";
import { claimRequestRow, seedPaddleConnection } from "./support/paddle.ts";
import { T0, uniqueId } from "./support/rows.ts";

// Envelopes are found by the master-key ID they record. Each test uses its own key IDs, so rows
// other tests stored never match.
const envelopeUnder = (kid: string, tag = "x") =>
  JSON.stringify({ v: 1, kid, iv: "aa", ct: tag, wiv: "cc", wk: "dd" });

async function seeded() {
  const old = uniqueId("old");
  const older = uniqueId("older");
  const current = uniqueId("cur");
  const { workspaceId, userId } = await workspaceWithOwner();
  const connection = await seedPaddleConnection(workspaceId, {
    apiKeyEnvelope: envelopeUnder(old, "api"),
    webhookSecretEnvelope: envelopeUnder(current, "secret"),
    destinationNextId: "ntfset_next",
    webhookSecretNextEnvelope: envelopeUnder(older, "next"),
  });
  const pending = claimRequestRow(workspaceId, userId, { emailEnvelope: envelopeUnder(old, "e") });
  const handled = claimRequestRow(workspaceId, userId, {
    emailEnvelope: null,
    processedAt: T0,
  });
  await db.insert(schema.claimRequests).values([pending, handled]);
  return { old, older, current, workspaceId, connection, pending };
}

describe("envelopes under retired master keys", () => {
  it("lists every envelope column's envelopes under the given keys, in a stable order", async () => {
    const { old, older, workspaceId, connection, pending } = await seeded();
    expect(await listEnvelopesUnderKeys(db, { keyIds: [old, older], limit: 10 })).toEqual([
      {
        table: "paddle_connections",
        field: "api_key",
        workspaceId,
        rowId: connection.id,
        envelope: envelopeUnder(old, "api"),
      },
      {
        table: "paddle_connections",
        field: "webhook_secret_next",
        workspaceId,
        rowId: connection.id,
        envelope: envelopeUnder(older, "next"),
      },
      {
        table: "claim_requests",
        field: "email",
        workspaceId,
        rowId: pending.id,
        envelope: envelopeUnder(old, "e"),
      },
    ]);
    expect(await countEnvelopesUnderKeys(db, [old, older])).toBe(3);
    expect(await countEnvelopesUnderKeys(db, [older])).toBe(1);
    // Bounded: the first ones only.
    const first = await listEnvelopesUnderKeys(db, { keyIds: [old, older], limit: 2 });
    expect(first.map((e) => e.field)).toEqual(["api_key", "webhook_secret_next"]);
  });

  it("finds the webhook secret's envelope too, and nothing without key IDs", async () => {
    const { current, connection } = await seeded();
    expect(await listEnvelopesUnderKeys(db, { keyIds: [current], limit: 10 })).toEqual([
      expect.objectContaining({ field: "webhook_secret", rowId: connection.id }),
    ]);
    expect(await listEnvelopesUnderKeys(db, { keyIds: [], limit: 10 })).toEqual([]);
    expect(await countEnvelopesUnderKeys(db, [])).toBe(0);
  });

  it("re-wraps a pending claim request's email once, guarded on the old envelope", async () => {
    const { old, workspaceId, pending } = await seeded();
    const next = envelopeUnder(uniqueId("new"), "e");
    const rewrap = { workspaceId, id: pending.id, previous: envelopeUnder(old, "e"), next };
    expect(await rewrapClaimRequestEmail(db, rewrap)).toBe(true);
    expect(await rewrapClaimRequestEmail(db, rewrap)).toBe(false);
    expect(await countEnvelopesUnderKeys(db, [old])).toBe(1);
    const other = await workspaceWithOwner();
    expect(
      await rewrapClaimRequestEmail(db, {
        ...rewrap,
        workspaceId: other.workspaceId,
        previous: next,
      }),
    ).toBe(false);
  });
});
