import * as repo from "@sharerepo/db";
import { auditEvent, OutboxKind, type ParseResult } from "@sharerepo/domain";
import { type CredentialKeyring, envelopeAad, openSecret, sealSecret } from "@sharerepo/platform";
import { atOneInstant, type ServiceContext } from "./context.ts";

// Rotating `CREDENTIAL_KEYS` (decision 0011, Phase 6 secret rotation). Envelopes are re-wrapped
// lazily when used; the `rewrap_credentials` job moves every remaining envelope off the keyring's
// other keys, in bounded runs, so a retired key can be removed once none references it. The job
// opens each envelope only to re-seal it: the plaintext never leaves this module's call.

const SYSTEM = { type: "system", id: null } as const;

/** Envelopes one run re-wraps at most; a run that leaves work re-queues the next. */
export const REWRAP_BATCH = 50;

const REWRAP_KEY = /^rewrap:(0|[1-9]\d{0,5})$/;

/**
 * The outbox key of a run: `rewrap:<generation>`. Each run that leaves work queues the next
 * generation, deduplicated, so a run delivered twice queues one successor.
 */
export function encodeRewrapKey(generation: number): string {
  return `rewrap:${generation}`;
}

export function decodeRewrapKey(key: string): ParseResult<number, "key_invalid"> {
  const match = REWRAP_KEY.exec(key);
  return match === null
    ? { ok: false, error: "key_invalid" }
    : { ok: true, value: Number(match[1]) };
}

/** The keyring's listed keys other than the current one: those an envelope must move off. */
const retiredKeyIds = (keyring: CredentialKeyring) =>
  Object.keys(keyring.keys).filter((id) => id !== keyring.current);

const rewrapRow = (id: string, generation: number, now: number): repo.NewOutboxRow => ({
  id,
  kind: OutboxKind.RewrapCredentials,
  subjectId: encodeRewrapKey(generation),
  createdAt: now,
  availableAt: now,
  // System-wide work: it spans every workspace's envelopes (decision 0014).
  workspaceId: null,
});

/**
 * The daily check: queues a `rewrap_credentials` run when any envelope is still sealed under a
 * listed key other than the current one, unless one is already queued. Returns whether it queued.
 */
export async function queueCredentialRewrap(
  context: ServiceContext,
  deps: { readonly credentialKeys: CredentialKeyring },
): Promise<boolean> {
  const ctx = atOneInstant(context);
  const stale = await repo.countEnvelopesUnderKeys(ctx.db, retiredKeyIds(deps.credentialKeys));
  if (stale === 0) return false;
  return repo.enqueueOutboxOnce(ctx.db, rewrapRow(ctx.ids.next(), 0, ctx.clock.now()));
}

export interface RewrapRunSummary {
  /** Envelopes moved to the current master key by this run. */
  readonly rewrapped: number;
  /** Envelopes that would not open (tampered, or bound to another row): left as they are. */
  readonly failed: number;
  /** Envelopes still under another listed key after the run. */
  readonly remaining: number;
  /** Whether the next run was queued. */
  readonly continued: boolean;
}

/**
 * One `rewrap_credentials` run: re-seals up to {@link REWRAP_BATCH} envelopes still under a listed
 * key other than the current one (Paddle API keys and webhook secrets, a rotation's next webhook
 * secret, pending claim request emails). Each write is guarded on the envelope it replaces, so a
 * concurrent lazy re-wrap, reconnect, rotation or erasure wins. A Paddle envelope is audited like
 * a lazy re-wrap (`paddle.credentials_rewrapped`); the run is audited `credentials.rewrapped`
 * with its counts. A run that moved something and left work queues the next run; one that moved
 * nothing stops, so envelopes that never open cannot keep the job alive. Idempotent.
 */
export async function rewrapCredentials(
  context: ServiceContext,
  generation: number,
  deps: { readonly credentialKeys: CredentialKeyring },
): Promise<RewrapRunSummary> {
  const ctx = atOneInstant(context);
  const keyring = deps.credentialKeys;
  const keyIds = retiredKeyIds(keyring);
  const envelopes = await repo.listEnvelopesUnderKeys(ctx.db, { keyIds, limit: REWRAP_BATCH });
  let rewrapped = 0;
  let failed = 0;
  for (const stored of envelopes) {
    const { workspaceId, rowId, field, envelope } = stored;
    const aad = envelopeAad({ workspaceId, rowId, purpose: field });
    let next: string;
    try {
      const { plaintext } = await openSecret({ keyring, envelope, aad });
      next = await sealSecret({ keyring, plaintext, aad });
    } catch {
      // A CredentialEnvelopeError, the only way these fail: tampered, or bound to another row.
      failed += 1;
      continue;
    }
    const wrote =
      field === "email"
        ? await repo.rewrapClaimRequestEmail(ctx.db, {
            workspaceId,
            id: rowId,
            previous: envelope,
            next,
          })
        : (
            await repo.rewrapPaddleEnvelope(
              ctx.db,
              { workspaceId, connectionId: rowId, field, previous: envelope, next },
              [
                auditEvent(
                  "paddle.credentials_rewrapped",
                  { workspaceId, actor: SYSTEM, targetId: rowId, details: { field } },
                  ctx,
                ),
              ],
            )
          ).ok;
    if (wrote) rewrapped += 1;
  }
  const remaining = await repo.countEnvelopesUnderKeys(ctx.db, keyIds);
  await repo.appendAuditEvents(ctx.db, [
    auditEvent(
      "credentials.rewrapped",
      {
        actor: SYSTEM,
        targetId: encodeRewrapKey(generation),
        details: { rewrapped, failed, remaining },
      },
      ctx,
    ),
  ]);
  const continued =
    rewrapped > 0 &&
    remaining > 0 &&
    (await repo.enqueueOutboxOnce(
      ctx.db,
      rewrapRow(ctx.ids.next(), generation + 1, ctx.clock.now()),
    ));
  return { rewrapped, failed, remaining, continued };
}
