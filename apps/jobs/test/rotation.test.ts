import { env } from "cloudflare:workers";
import { encodeRewrapKey } from "@sharerepo/application";
import { enqueueOutbox, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { envelopeAad, openSecret, parseCommerceSecrets, sealSecret } from "@sharerepo/platform";
import { captureLogs, type LogCapture } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import { clock, db, envWithGitHub } from "./support/github.ts";
import { paddleShop, paddleWorker } from "./support/paddle.ts";
import { deliver, outboxRow, runCron } from "./support/worker.ts";

// `CREDENTIAL_KEYS` rotation at the jobs Worker (Phase 6): the daily check queues
// `rewrap_credentials`, and the job moves envelopes off retired keys. The Worker's own test key
// stays current, so envelopes other tests sealed are never touched: only those sealed here under
// a key of this file's own are retired.

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

const configured = (() => {
  const parsed = parseCommerceSecrets(env);
  if (parsed === null) throw new Error("test: commerce secrets are not configured");
  return parsed.credentialKeys;
})();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The Worker's keyring plus a retired key of this test's own, which sealed the test's rows. */
function rotatedEnv() {
  const retiredId = `jobs-old-${Math.floor(Math.random() * 1e9)}`;
  const retiredKey = crypto.getRandomValues(new Uint8Array(32));
  const keys: Record<string, string> = { [retiredId]: toBase64(retiredKey) };
  for (const [id, key] of Object.entries(configured.keys)) keys[id] = toBase64(key);
  const bindings = {
    ...envWithGitHub,
    CREDENTIAL_KEYS: JSON.stringify({ current: configured.current, keys }),
  } as Env;
  const retired = { current: retiredId, keys: { [retiredId]: retiredKey } };
  return { bindings, retired, retiredId };
}

/** A pending claim request whose email is sealed under `keyring`. */
async function pendingRequest(
  workspaceId: string,
  userId: string,
  keyring: Parameters<typeof sealSecret>[0]["keyring"],
) {
  const id = `clr-${crypto.randomUUID()}`;
  const aad = envelopeAad({ workspaceId, rowId: id, purpose: "email" });
  const envelope = await sealSecret({ keyring, plaintext: "buyer@example.com", aad });
  await env.DB.prepare(
    "INSERT INTO claim_requests (id, workspace_id, user_id, email_hash, email_envelope, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, workspaceId, userId, "b".repeat(64), envelope, clock.now())
    .run();
  return { id, aad };
}

const pendingRewraps = async () =>
  (
    await env.DB.prepare(
      "SELECT id, subject_id FROM outbox WHERE kind = 'rewrap_credentials' AND sent_at IS NULL AND failed_at IS NULL",
    ).all<{ id: string; subject_id: string }>()
  ).results;

describe("rewrap_credentials at the jobs Worker", () => {
  it("is queued by the daily check while an envelope is under a retired key, then re-wraps it", async () => {
    const s = await paddleShop();
    const { bindings, retired } = rotatedEnv();
    const request = await pendingRequest(s.workspaceId, s.userId, retired);
    // Runs queued by other tests are done.
    await env.DB.prepare(
      "UPDATE outbox SET sent_at = ? WHERE kind = 'rewrap_credentials' AND sent_at IS NULL",
    )
      .bind(clock.now())
      .run();

    await runCron(paddleWorker(s), CRONS.dailyResync, bindings);
    await runCron(paddleWorker(s), CRONS.dailyResync, bindings);
    const [row] = await pendingRewraps();
    expect(await pendingRewraps()).toEqual([{ id: row?.id, subject_id: encodeRewrapKey(0) }]);
    expect(logs.lines().map((line) => JSON.parse(line).msg)).toContain("credential rewrap check");

    const result = await deliver(
      paddleWorker(s),
      [{ kind: "rewrap_credentials", subjectId: encodeRewrapKey(0), outboxId: row?.id }],
      { bindings },
    );
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(row?.id as string)).toMatchObject({ sent_at: clock.now() });
    const stored = await env.DB.prepare("SELECT email_envelope FROM claim_requests WHERE id = ?")
      .bind(request.id)
      .first<{ email_envelope: string }>();
    // The Worker's own key opens it now: the retired key can be removed.
    expect(
      (
        await openSecret({
          keyring: configured,
          envelope: stored?.email_envelope as string,
          aad: request.aad,
        })
      ).plaintext,
    ).toBe("buyer@example.com");
    const correlationIds = await env.DB.prepare(
      "SELECT correlation_id, details FROM audit_events WHERE action = 'credentials.rewrapped' ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
    ).first<{ correlation_id: string; details: string }>();
    expect(JSON.parse(correlationIds?.details as string)).toMatchObject({ remaining: 0 });
    expect(
      (await listAuditEventsByCorrelationId(db, correlationIds?.correlation_id as string)).map(
        (event) => event.action,
      ),
    ).toContain("credentials.rewrapped");
    // Nothing is left: the daily check queues nothing more.
    await runCron(paddleWorker(s), CRONS.dailyResync, bindings);
    expect(await pendingRewraps()).toEqual([]);
  });

  it("queues nothing without commerce secrets, and fails a key that does not decode", async () => {
    const s = await paddleShop();
    const bare = { ...envWithGitHub, CREDENTIAL_KEYS: undefined, CLAIM_SIGNING_KEY: undefined };
    await runCron(paddleWorker(s), CRONS.dailyResync, bare as unknown as Env);
    expect(logs.lines().map((line) => JSON.parse(line).msg)).not.toContain(
      "credential rewrap check",
    );
    const outboxId = `row-${crypto.randomUUID()}`;
    await enqueueOutbox(db, {
      id: outboxId,
      kind: "rewrap_credentials",
      subjectId: "rewrap:x",
      createdAt: clock.now(),
      availableAt: clock.now(),
      workspaceId: null,
    });
    await deliver(paddleWorker(s), [
      { kind: "rewrap_credentials", subjectId: "rewrap:x", outboxId },
    ]);
    expect(await outboxRow(outboxId)).toMatchObject({ last_error_code: "key_invalid" });
  });

  it("logs a failed check by classification only", async () => {
    const s = await paddleShop();
    const { bindings } = rotatedEnv();
    const failing = {
      ...bindings,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare") {
            return (query: string) => {
              if (query.includes("json_extract")) throw new Error("envelopes down");
              return target.prepare(query);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    await runCron(paddleWorker(s), CRONS.dailyResync, failing);
    expect(logs.lines().map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "credential rewrap check failed", errorName: "Error" }),
        expect.objectContaining({ msg: "daily resync queued" }),
      ]),
    );
    expect(logs.text()).not.toContain("envelopes down");
  });
});
