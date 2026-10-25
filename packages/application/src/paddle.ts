import * as repo from "@sharerepo/db";
import {
  AlertName,
  type AuditEvent,
  auditEvent,
  ConnectionCallOutcome,
  dailyOffsetMs,
  type Instant,
  nextConnectionStatus,
  OutboxKind,
  type PaddleBillingInterval,
  type PaddleConnectionStatus,
  type PaddleEnvironment,
  type PaddlePriceStatus,
} from "@sharerepo/domain";
import {
  type CreatedNotificationSetting,
  isDestinationLimitError,
  normalizePaddleSubscription,
  PaddleApiError,
  type PaddleApiKey,
  type PaddleApiKeyError,
  type PaddleApiRoot,
  type PaddleEnvelope,
  type PaddlePort,
  type PaddleSubscription,
  parsePaddleApiKey,
  parsePaddleEnvelope,
  payloadDigest,
  verifyPaddleSignature,
} from "@sharerepo/integrations";
import {
  type ClaimSigningKeyring,
  ConflictError,
  type CredentialKeyring,
  envelopeAad,
  openSecret,
  ServiceUnavailableError,
  sealSecret,
} from "@sharerepo/platform";
import {
  asAuditActor,
  atOneInstant,
  raiseAlert,
  type ServiceContext,
  type UserActor,
} from "./context.ts";
import {
  type EntitlementSourcePort,
  encodePaddleConnectionKey,
  type PaddleConnectionRef,
} from "./entitlement-source.ts";
import type { ProcessEventOutcome } from "./github.ts";
import { refreshOutboxRow } from "./subscriptions.ts";
import { openWorkspace } from "./workspaces.ts";

// Paddle connections and events (decision 0011, Phase 5 plan). A creator connects with an API key;
// ShareRepo registers its own webhook destination, keeps both secrets as envelopes bound to the
// connection row, and treats every webhook as a hint to re-read the subscription from Paddle.
//
// Audit (decision 0007): connecting, reconnecting, disconnecting, status changes, catalog syncs
// and credential re-wraps are audited. `last_event_at` (markPaddleEventReceived) and
// `last_checked_at` (recordPaddleConnectionChecked) are bookkeeping stamps, like the outbox and
// `external_events`: they record that something was observed, not a decision, so they carry no
// audit event.

const SYSTEM = { type: "system", id: null } as const;
const DAY_MS = 86_400_000;

/** Where ShareRepo runs (`ENVIRONMENT`). Production accepts only live keys, the rest sandbox keys. */
export type Deployment = "development" | "e2e" | "production";

/** What the commerce services need beyond the service context. Built once per Worker from env. */
export interface CommerceDeps {
  /** A Paddle client for one key in its environment; tests return a `FakePaddle`. */
  readonly paddle: (credentials: {
    readonly apiKey: string;
    readonly environment: PaddleEnvironment;
  }) => PaddlePort;
  /** `CREDENTIAL_KEYS`: seals and opens tenant credential envelopes. */
  readonly credentialKeys: CredentialKeyring;
  /**
   * `CLAIM_SIGNING_KEY`: claim references, email and IP hashes. The current key signs and hashes;
   * the others still listed verify references and count rate limits during a rotation.
   */
  readonly claimSigningKeys: ClaimSigningKeyring;
  /** The public origin (`https://sharerepo.org`): webhook destinations and claim links. */
  readonly baseUrl: string;
  readonly deployment: Deployment;
}

/** Every permission a key must carry (decision 0011). `account.read` is optional. */
export const PADDLE_REQUIRED_PERMISSIONS = [
  "product.read",
  "price.read",
  "customer.read",
  "subscription.read",
  "transaction.read",
  "transaction.write",
  "notification_setting.write",
] as const;

/** The events ShareRepo's destination subscribes to (decision 0011). */
export const PADDLE_WEBHOOK_EVENTS = [
  "subscription.activated",
  "subscription.canceled",
  "subscription.created",
  "subscription.imported",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.trialing",
  "subscription.updated",
  "transaction.completed",
  "transaction.paid",
  "transaction.payment_failed",
  "api_key.created",
  "api_key.expired",
  "api_key.expiring",
  "api_key.revoked",
  "api_key.updated",
] as const;

/** The billing page warns from this long before the key's expiry date (decision 0011). */
export const PADDLE_KEY_EXPIRY_WARNING_MS = 14 * DAY_MS;

/** Why a connection is `unauthorized`: its `status_reason`, and the status event's reason. */
export const PaddleStatusReason = {
  /** Paddle answered 401 or 403. */
  KeyRefused: "key_refused",
  /** The key now belongs to another seller account. */
  SellerChanged: "seller_changed",
  /** The key lost a required permission. */
  PermissionsMissing: "permissions_missing",
} as const;
export type PaddleStatusReason = (typeof PaddleStatusReason)[keyof typeof PaddleStatusReason];

/**
 * Paddle cannot be read for the workspace now: it has no active connection, or Paddle refused the
 * key (which marks the connection unauthorized). Worth retrying once the creator reconnects; the
 * stored commercial facts stand meanwhile (decision 0011).
 */
export class PaddleUnavailableError extends ServiceUnavailableError {
  constructor(message: string) {
    super(message, { code: "source_unavailable" });
  }
}

type LiveStatus = Exclude<PaddleConnectionStatus, "disconnected">;

const isUnauthorized = (error: unknown) =>
  error instanceof PaddleApiError && error.kind === "unauthorized";

const expectedEnvironment = (deps: CommerceDeps): PaddleEnvironment =>
  deps.deployment === "production" ? "live" : "sandbox";

/**
 * The connection's webhook URL. A rotation's second destination adds a version marker
 * (`?v=<marker>`): Paddle refuses two destinations with the same URL, and the webhook route reads
 * the connection from the path only, so both destinations reach the same connection.
 */
const webhookUrl = (deps: CommerceDeps, connectionId: string, marker?: string) =>
  `${deps.baseUrl.replace(/\/+$/, "")}/webhooks/paddle/${connectionId}${
    marker === undefined ? "" : `?v=${encodeURIComponent(marker)}`
  }`;

// Credentials ----------------------------------------------------------------------------------

/**
 * Opens one of a connection's envelopes. One sealed under a retired master key is re-sealed
 * under the current key and stored (guarded on the old envelope, audited), so rotation completes
 * as connections are used (decision 0011). The plaintext never leaves the caller's adapter call.
 */
async function openCredential(
  ctx: ServiceContext,
  deps: Pick<CommerceDeps, "credentialKeys">,
  connection: { readonly workspaceId: string; readonly id: string },
  field: repo.PaddleEnvelopeField,
  envelope: string,
): Promise<string> {
  const { workspaceId, id: connectionId } = connection;
  const aad = envelopeAad({ workspaceId, rowId: connectionId, purpose: field });
  const keyring = deps.credentialKeys;
  const opened = await openSecret({ keyring, envelope, aad });
  if (opened.needsRewrap) {
    const next = await sealSecret({ keyring, plaintext: opened.plaintext, aad });
    await repo.rewrapPaddleEnvelope(
      ctx.db,
      { workspaceId, connectionId, field, previous: envelope, next },
      [
        auditEvent(
          "paddle.credentials_rewrapped",
          { workspaceId, actor: SYSTEM, targetId: connectionId, details: { field } },
          ctx,
        ),
      ],
    );
  }
  return opened.plaintext;
}

/** A client with the connection's key. A live connection always has both envelopes (CHECK). */
async function clientFor(
  ctx: ServiceContext,
  deps: CommerceDeps,
  connection: repo.PaddleConnection,
): Promise<PaddlePort> {
  const envelope = connection.apiKeyEnvelope as string;
  const apiKey = await openCredential(ctx, deps, connection, "api_key", envelope);
  return deps.paddle({ apiKey, environment: connection.environment });
}

/**
 * Moves a live connection to `status`, guarded on the status it was read with, with its audit
 * event. Nothing to do when it already has that status; a concurrent change wins.
 */
async function changeStatus(
  ctx: ServiceContext,
  connection: repo.PaddleConnection,
  status: LiveStatus,
  reason: PaddleStatusReason | null,
): Promise<void> {
  const previousStatus = connection.status as LiveStatus;
  if (previousStatus === status) return;
  const { workspaceId, id: connectionId } = connection;
  const changed = await repo.updatePaddleConnectionStatus(
    ctx.db,
    {
      workspaceId,
      connectionId,
      expectedStatus: previousStatus,
      status,
      statusReason: reason,
      now: ctx.clock.now(),
    },
    [
      auditEvent(
        "paddle.status_changed",
        {
          workspaceId,
          actor: SYSTEM,
          targetId: connectionId,
          ...(reason === null ? {} : { reason }),
          details: { previousStatus, status },
        },
        ctx,
      ),
    ],
  );
  // Paddle refused the key: subscriptions can no longer be read (decision 0014).
  if (changed.ok && status === "unauthorized") {
    raiseAlert(ctx, AlertName.ConnectionLost, {
      workspaceId,
      connectionId,
      provider: "paddle",
      status,
    });
  }
}

/**
 * Calls Paddle with the connection's key. A 401 or 403 marks the connection unauthorized and
 * fails as unavailable (decision 0011 § Health); nothing else changes, so the last known facts
 * stand. Other failures propagate as they are.
 */
export async function withPaddle<T>(
  ctx: ServiceContext,
  deps: CommerceDeps,
  connection: repo.PaddleConnection,
  call: (client: PaddlePort) => Promise<T>,
): Promise<T> {
  const client = await clientFor(ctx, deps, connection);
  try {
    return await call(client);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    await changeStatus(ctx, connection, "unauthorized", PaddleStatusReason.KeyRefused);
    throw new PaddleUnavailableError("Paddle refused the connection's key");
  }
}

/** The workspace's live connection when it is the one named, else null. */
async function namedConnection(
  ctx: ServiceContext,
  ref: PaddleConnectionRef,
): Promise<repo.PaddleConnection | null> {
  const connection = await repo.getPaddleConnection(ctx.db, { workspaceId: ref.workspaceId });
  return connection?.id === ref.connectionId ? connection : null;
}

/**
 * The workspace's connection, when it is `active`: the only state in which ShareRepo reads Paddle
 * on its own initiative. Null otherwise.
 */
export async function activePaddleConnection(
  ctx: ServiceContext,
  workspaceId: string,
): Promise<repo.PaddleConnection | null> {
  const connection = await repo.getPaddleConnection(ctx.db, { workspaceId });
  return connection?.status === "active" ? connection : null;
}

// Connecting -----------------------------------------------------------------------------------

/**
 * Why a key was refused:
 * - `api_key_invalid`, `api_key_legacy`: not a current Paddle key (legacy keys have no scopes);
 * - `environment_mismatch`: a sandbox key in production, a live key elsewhere, or a seller
 *   account Paddle reports in the other environment;
 * - `key_refused`: Paddle answered 401 or 403 (revoked, expired or mistyped);
 * - `missing_permissions`: the key lacks the permissions in `missing`.
 */
export type PaddleKeyError =
  | { readonly reason: PaddleApiKeyError | "environment_mismatch" | "key_refused" }
  | { readonly reason: "missing_permissions"; readonly missing: readonly string[] };

type CheckedKey =
  | {
      readonly ok: true;
      readonly key: PaddleApiKey;
      readonly client: PaddlePort;
      readonly root: PaddleApiRoot;
    }
  | { readonly ok: false; readonly error: PaddleKeyError };

/** The permissions a key reports missing, or an environment that differs; null when usable. */
function apiRootProblem(
  root: PaddleApiRoot,
  environment: PaddleEnvironment,
): PaddleKeyError | null {
  if (root.environment !== environment) return { reason: "environment_mismatch" };
  const missing = PADDLE_REQUIRED_PERMISSIONS.filter((p) => !root.permissions.includes(p));
  return missing.length === 0 ? null : { reason: "missing_permissions", missing };
}

/** Validates a pasted key and asks Paddle who it belongs to (`GET /`). Errors never echo it. */
async function checkKey(deps: CommerceDeps, apiKey: string): Promise<CheckedKey> {
  const parsed = parsePaddleApiKey(apiKey);
  if (!parsed.ok) return { ok: false, error: { reason: parsed.error } };
  const key = parsed.value;
  if (key.environment !== expectedEnvironment(deps)) {
    return { ok: false, error: { reason: "environment_mismatch" } };
  }
  const client = deps.paddle({ apiKey: key.key, environment: key.environment });
  let root: PaddleApiRoot;
  try {
    root = await client.getApiRoot();
  } catch (error) {
    if (isUnauthorized(error)) return { ok: false, error: { reason: "key_refused" } };
    throw error;
  }
  const problem = apiRootProblem(root, key.environment);
  return problem === null ? { ok: true, key, client, root } : { ok: false, error: problem };
}

/** Deletes a destination ShareRepo created; false when Paddle could not be asked. */
async function deleteDestination(client: PaddlePort, destinationId: string): Promise<boolean> {
  try {
    await client.deleteNotificationSetting(destinationId);
    return true;
  } catch {
    return false;
  }
}

/** A new destination for the connection's URL, or null when the seller has 10 already. */
async function createDestination(
  deps: CommerceDeps,
  client: PaddlePort,
  connectionId: string,
  marker?: string,
): Promise<CreatedNotificationSetting | null> {
  try {
    return await client.createNotificationSetting({
      destination: webhookUrl(deps, connectionId, marker),
      events: PADDLE_WEBHOOK_EVENTS,
    });
  } catch (error) {
    if (isDestinationLimitError(error)) return null;
    throw error;
  }
}

function sealFor(
  deps: CommerceDeps,
  connection: { readonly workspaceId: string; readonly connectionId: string },
  purpose: repo.PaddleEnvelopeField,
  plaintext: string,
): Promise<string> {
  const aad = envelopeAad({
    workspaceId: connection.workspaceId,
    rowId: connection.connectionId,
    purpose,
  });
  return sealSecret({ keyring: deps.credentialKeys, plaintext, aad });
}

export interface CatalogSyncSummary {
  readonly added: number;
  readonly updated: number;
  readonly archived: number;
}

export type ConnectPaddleResult =
  | {
      readonly ok: true;
      readonly connectionId: string;
      /** The imported catalog; null when the import failed (the owner can refresh it). */
      readonly catalog: CatalogSyncSummary | null;
    }
  | {
      readonly ok: false;
      readonly error:
        | PaddleKeyError
        /** The workspace already has a connection: reconnect or disconnect it first. */
        | { readonly reason: "already_connected" }
        /** The seller has 10 active destinations; nothing was stored. */
        | { readonly reason: "destination_limit" };
    };

/**
 * Connects the workspace's Paddle seller account (decision 0011). Needs `workspace.manage`. The
 * key must be for this deployment's environment and carry every required permission. ShareRepo
 * then creates its webhook destination, stores the key and the destination's secret as envelopes
 * bound to the new row, audits `paddle.connected`, and imports the catalog. If storing fails after
 * the destination exists, the destination is deleted again (best effort).
 */
export async function connectPaddle(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly apiKey: string; readonly apiKeyExpiresOn: Instant | null },
  deps: CommerceDeps,
): Promise<ConnectPaddleResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const refused = (error: Extract<ConnectPaddleResult, { ok: false }>["error"]) =>
    ({ ok: false, error }) as const;
  if ((await repo.getPaddleConnection(ctx.db, { workspaceId })) !== null) {
    return refused({ reason: "already_connected" });
  }
  const checked = await checkKey(deps, input.apiKey);
  if (!checked.ok) return refused(checked.error);
  const { key, client, root } = checked;

  const connectionId = ctx.ids.next();
  const destination = await createDestination(deps, client, connectionId);
  if (destination === null) return refused({ reason: "destination_limit" });
  const now = ctx.clock.now();
  const ids = { workspaceId, connectionId };
  let row: repo.PaddleConnection;
  let created: repo.CreatePaddleConnectionResult;
  try {
    row = {
      id: connectionId,
      workspaceId,
      environment: key.environment,
      sellerId: root.sellerId,
      sellerName: root.sellerName,
      credentialKind: "api_key",
      apiKeyEnvelope: await sealFor(deps, ids, "api_key", key.key),
      apiKeyExpiresOn: input.apiKeyExpiresOn,
      destinationId: destination.id,
      webhookSecretEnvelope: await sealFor(deps, ids, "webhook_secret", destination.secret),
      destinationNextId: null,
      webhookSecretNextEnvelope: null,
      status: "active",
      statusReason: null,
      lastEventAt: null,
      lastCheckedAt: now,
      catalogSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    created = await repo.createPaddleConnection(ctx.db, row, [
      auditEvent(
        "paddle.connected",
        {
          workspaceId,
          actor: asAuditActor(actor),
          targetId: connectionId,
          details: { environment: key.environment, sellerId: root.sellerId },
        },
        ctx,
      ),
    ]);
  } catch (error) {
    await deleteDestination(client, destination.id);
    throw error;
  }
  if (!created.ok) {
    // Another connect for this workspace won the race.
    await deleteDestination(client, destination.id);
    return refused({ reason: "already_connected" });
  }
  let catalog: CatalogSyncSummary | null;
  try {
    catalog = await importCatalog(ctx, deps, row, asAuditActor(actor));
  } catch {
    // The connection stands; the billing page offers "Refresh catalog".
    catalog = null;
  }
  return { ok: true, connectionId, catalog };
}

export type ReconnectPaddleResult =
  | { readonly ok: true; readonly destinationRecreated: boolean }
  | {
      readonly ok: false;
      readonly error:
        | PaddleKeyError
        /** The workspace has no connection to reconnect. */
        | { readonly reason: "not_connected" }
        /** The key belongs to another seller: disconnect first (decision 0011). */
        | { readonly reason: "seller_mismatch" }
        | { readonly reason: "destination_limit" };
    };

/**
 * Replaces the connection's key with a new one for the same seller (rotation, or after expiry or
 * revocation) and makes it active again. Needs `workspace.manage`. A destination deleted outside
 * ShareRepo is created again; otherwise it stays, with its secret.
 */
export async function reconnectPaddle(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly apiKey: string; readonly apiKeyExpiresOn: Instant | null },
  deps: CommerceDeps,
): Promise<ReconnectPaddleResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const refused = (error: Extract<ReconnectPaddleResult, { ok: false }>["error"]) =>
    ({ ok: false, error }) as const;
  const connection = await repo.getPaddleConnection(ctx.db, { workspaceId });
  if (connection === null) return refused({ reason: "not_connected" });
  const checked = await checkKey(deps, input.apiKey);
  if (!checked.ok) return refused(checked.error);
  const { key, client, root } = checked;
  if (root.sellerId !== connection.sellerId) return refused({ reason: "seller_mismatch" });

  const ids = { workspaceId, connectionId: connection.id };
  const previousDestination = connection.destinationId as string;
  let destination: CreatedNotificationSetting | null = null;
  try {
    await client.getNotificationSetting(previousDestination);
  } catch (error) {
    if (!(error instanceof PaddleApiError && error.kind === "not_found")) throw error;
    destination = await createDestination(deps, client, connection.id);
    if (destination === null) return refused({ reason: "destination_limit" });
  }
  const result = await repo.replacePaddleCredentials(
    ctx.db,
    {
      ...ids,
      sellerId: root.sellerId,
      sellerName: root.sellerName,
      apiKeyEnvelope: await sealFor(deps, ids, "api_key", key.key),
      apiKeyExpiresOn: input.apiKeyExpiresOn,
      ...(destination === null
        ? {}
        : {
            destination: {
              id: destination.id,
              webhookSecretEnvelope: await sealFor(deps, ids, "webhook_secret", destination.secret),
            },
          }),
      now: ctx.clock.now(),
    },
    [
      auditEvent(
        "paddle.reconnected",
        {
          workspaceId,
          actor: asAuditActor(actor),
          targetId: connection.id,
          details: {
            sellerId: root.sellerId,
            previousStatus: connection.status as LiveStatus,
            destinationRecreated: destination !== null,
          },
        },
        ctx,
      ),
    ],
  );
  if (!result.ok) {
    // Disconnected concurrently: the new destination would deliver to a 404.
    if (destination !== null) await deleteDestination(client, destination.id);
    return refused({ reason: "not_connected" });
  }
  return { ok: true, destinationRecreated: destination !== null };
}

export type DisconnectPaddleResult =
  | {
      readonly ok: true;
      /**
       * False when Paddle could not be asked: the creator must delete each of
       * `orphanedDestinationIds` there.
       */
      readonly destinationDeleted: boolean;
      readonly destinationId: string;
      /** The destinations ShareRepo could not delete, a rotation's second one included. */
      readonly orphanedDestinationIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: "not_connected" };

/**
 * Disconnects the workspace's Paddle account (decision 0011): deletes the destination, and a
 * webhook rotation's second destination if there is one (best effort), erases every envelope and
 * marks the connection disconnected. Customers, subscriptions and entitlements stay as history.
 * Needs `workspace.manage`.
 */
export async function disconnectPaddle(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  deps: CommerceDeps,
): Promise<DisconnectPaddleResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const connection = await repo.getPaddleConnection(ctx.db, { workspaceId });
  if (connection === null) return { ok: false, reason: "not_connected" };
  const destinationId = connection.destinationId as string;
  const nextId = connection.destinationNextId;
  const client = await clientFor(ctx, deps, connection).catch(() => null);
  const deleted = async (id: string) => client !== null && deleteDestination(client, id);
  const currentDeleted = await deleted(destinationId);
  const nextDeleted = nextId === null || (await deleted(nextId));
  const orphanedDestinationIds = [
    ...(currentDeleted ? [] : [destinationId]),
    ...(nextDeleted ? [] : [nextId as string]),
  ];
  const destinationDeleted = orphanedDestinationIds.length === 0;
  const result = await repo.disconnectPaddleConnection(
    ctx.db,
    {
      workspaceId,
      connectionId: connection.id,
      destinationId: currentDeleted ? null : destinationId,
      destinationNextId: nextDeleted ? null : nextId,
      now: ctx.clock.now(),
    },
    [
      auditEvent(
        "paddle.disconnected",
        {
          workspaceId,
          actor: asAuditActor(actor),
          targetId: connection.id,
          details: { previousStatus: connection.status as LiveStatus, destinationDeleted },
        },
        ctx,
      ),
    ],
  );
  if (!result.ok) return { ok: false, reason: "not_connected" };
  return { ok: true, destinationDeleted, destinationId, orphanedDestinationIds };
}

// Webhook secret rotation ----------------------------------------------------------------------

export type RotatePaddleWebhookSecretResult =
  | {
      readonly ok: true;
      /** The connection's destination now, whose secret is the only one accepted. */
      readonly destinationId: string;
    }
  | {
      readonly ok: false;
      /**
       * `not_connected`: no connection; `not_active`: the key is refused (reconnect first);
       * `destination_limit`: the seller has 10 active destinations, so no second one can be
       * created (nothing changed).
       */
      readonly reason: "not_connected" | "not_active" | "destination_limit";
    };

/** True when the destination still exists in Paddle and delivers. */
async function destinationDelivers(client: PaddlePort, destinationId: string): Promise<boolean> {
  try {
    return (await client.getNotificationSetting(destinationId)).active;
  } catch (error) {
    if (error instanceof PaddleApiError && error.kind === "not_found") return false;
    throw error;
  }
}

/**
 * "Rotate webhook secret" on the billing page (Phase 6, secret rotation). Paddle cannot rotate a
 * destination's secret, so ShareRepo replaces the destination. Needs `workspace.manage`.
 *
 * 1. **Start.** Create a second destination for the same connection, its URL marked `?v=<id>`;
 *    store its ID and secret (sealed for `webhook_secret_next`), audited
 *    `paddle.webhook_secret_rotated` (`started`). From then on the webhook accepts both secrets,
 *    and Paddle delivers every event to both destinations (deduplicated by event ID).
 * 2. **Complete.** Delete the old destination in Paddle, then promote the second destination and
 *    its secret (re-sealed for `webhook_secret`), audited (`completed`). Only the new secret is
 *    accepted afterwards.
 *
 * Every step leaves at least one destination and secret working, and running the action again
 * continues where it stopped: a rotation in progress is completed, an old destination already
 * deleted counts as deleted, and a second destination that no longer delivers is replaced. A
 * Paddle failure propagates (the page asks to try again); a concurrent rotation or disconnect is a
 * ConflictError. A second destination created but not stored is deleted again, best effort.
 */
export async function rotatePaddleWebhookSecret(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  deps: CommerceDeps,
): Promise<RotatePaddleWebhookSecretResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const connection = await repo.getPaddleConnection(ctx.db, { workspaceId });
  if (connection === null) return { ok: false, reason: "not_connected" };
  if (connection.status !== "active") return { ok: false, reason: "not_active" };
  const connectionId = connection.id;
  const ids = { workspaceId, connectionId };
  const by = asAuditActor(actor);
  const paddle = <T>(call: (client: PaddlePort) => Promise<T>) =>
    withPaddle(ctx, deps, connection, call);
  const previousDestinationId = connection.destinationId as string;
  const rotated = (stage: "started" | "completed", destinationId: string) =>
    auditEvent(
      "paddle.webhook_secret_rotated",
      {
        workspaceId,
        actor: by,
        targetId: connectionId,
        details: { stage, previousDestinationId, destinationId },
      },
      ctx,
    );

  // Step 1: a second destination that delivers, stored with its secret.
  let next: { id: string; envelope: string } | null = null;
  const pendingId = connection.destinationNextId;
  if (pendingId !== null) {
    if (await paddle((client) => destinationDelivers(client, pendingId))) {
      next = { id: pendingId, envelope: connection.webhookSecretNextEnvelope as string };
    } else {
      // Deleted or deactivated outside ShareRepo since the rotation started: replace it.
      await paddle((client) => deleteDestination(client, pendingId));
    }
  }
  if (next === null) {
    const created = await paddle((client) =>
      createDestination(deps, client, connectionId, ctx.ids.next()),
    );
    if (created === null) return { ok: false, reason: "destination_limit" };
    const discard = () => paddle((client) => deleteDestination(client, created.id));
    let envelope: string;
    let started: repo.GuardedWriteResult;
    try {
      envelope = await sealFor(deps, ids, "webhook_secret_next", created.secret);
      started = await repo.startPaddleWebhookRotation(
        ctx.db,
        {
          ...ids,
          destinationId: previousDestinationId,
          expectedNextId: pendingId,
          destinationNextId: created.id,
          webhookSecretNextEnvelope: envelope,
          now: ctx.clock.now(),
        },
        [rotated("started", created.id)],
      );
    } catch (error) {
      await discard();
      throw error;
    }
    if (!started.ok) {
      // Another rotation, a reconnect or a disconnect won: this destination would be orphaned.
      await discard();
      throw new ConflictError("the Paddle connection changed concurrently; retry");
    }
    next = { id: created.id, envelope };
  }

  // Step 2: delete the old destination ("not found" counts as deleted), then promote.
  await paddle((client) => client.deleteNotificationSetting(previousDestinationId));
  const secret = await openCredential(ctx, deps, connection, "webhook_secret_next", next.envelope);
  const completed = await repo.completePaddleWebhookRotation(
    ctx.db,
    {
      ...ids,
      previousDestinationId,
      destinationId: next.id,
      webhookSecretEnvelope: await sealFor(deps, ids, "webhook_secret", secret),
      now: ctx.clock.now(),
    },
    [rotated("completed", next.id)],
  );
  if (!completed.ok) throw new ConflictError("the Paddle connection changed concurrently; retry");
  return { ok: true, destinationId: next.id };
}

/**
 * Probes the connection's key (`GET /`) and moves its status accordingly (domain
 * `nextConnectionStatus`): a refused key, another seller or a missing permission makes it
 * unauthorized; a usable key makes it active again. System work for `check_paddle_connection`
 * (an `api_key.*` webhook). Transient and other failures propagate and change nothing. Returns
 * the status after the probe, or `not_connected` when the connection is gone.
 */
export async function checkPaddleConnection(
  context: ServiceContext,
  ref: PaddleConnectionRef,
  deps: CommerceDeps,
): Promise<LiveStatus | "not_connected"> {
  const ctx = atOneInstant(context);
  const connection = await namedConnection(ctx, ref);
  if (connection === null) return "not_connected";
  const client = await clientFor(ctx, deps, connection);
  let reason: PaddleStatusReason | null;
  try {
    const root = await client.getApiRoot();
    reason =
      root.sellerId !== connection.sellerId
        ? PaddleStatusReason.SellerChanged
        : apiRootProblem(root, connection.environment) === null
          ? null
          : PaddleStatusReason.PermissionsMissing;
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    reason = PaddleStatusReason.KeyRefused;
  }
  const outcome = reason === null ? ConnectionCallOutcome.Ok : ConnectionCallOutcome.Unauthorized;
  const status = nextConnectionStatus(connection.status, outcome) as LiveStatus;
  if (status === connection.status) {
    await repo.recordPaddleConnectionChecked(ctx.db, { ...ref, now: ctx.clock.now() });
  } else {
    await changeStatus(ctx, connection, status, reason);
  }
  return status;
}

// Catalog --------------------------------------------------------------------------------------

const PRICE_FIELDS = [
  "productId",
  "productName",
  "description",
  "billingInterval",
  "billingFrequency",
  "unitAmount",
  "currency",
  "status",
] as const;

/**
 * Imports every price with its product (`GET /prices?include=product`) and audits the sync.
 * Prices Paddle no longer lists stay as they are; archived ones stay, marked. Null when the
 * connection was disconnected meanwhile.
 */
async function importCatalog(
  ctx: ServiceContext,
  deps: CommerceDeps,
  connection: repo.PaddleConnection,
  actor: AuditEvent["actor"],
): Promise<CatalogSyncSummary | null> {
  const { workspaceId, id: connectionId } = connection;
  const prices = await withPaddle(ctx, deps, connection, (client) => client.listPrices());
  const stored = new Map(
    (await repo.listPaddlePrices(ctx.db, { workspaceId })).map((price) => [price.priceId, price]),
  );
  const summary = { added: 0, updated: 0, archived: 0 };
  const rows = prices.map((price): repo.PaddlePriceImport => {
    const before = stored.get(price.id);
    const row = {
      id: before?.id ?? ctx.ids.next(),
      priceId: price.id,
      productId: price.productId,
      productName: price.productName,
      description: price.description,
      billingInterval: price.billingCycle?.interval ?? null,
      billingFrequency: price.billingCycle?.frequency ?? null,
      unitAmount: price.unitAmount,
      currency: price.currency,
      status: price.status,
    };
    if (before === undefined) summary.added += 1;
    else if (before.status === "active" && row.status === "archived") summary.archived += 1;
    else if (PRICE_FIELDS.some((field) => before[field] !== row[field])) summary.updated += 1;
    return row;
  });
  const result = await repo.upsertPaddlePrices(
    ctx.db,
    { workspaceId, connectionId, prices: rows, now: ctx.clock.now() },
    [
      auditEvent(
        "paddle.catalog_synced",
        { workspaceId, actor, targetId: connectionId, details: summary },
        ctx,
      ),
    ],
  );
  return result.ok ? summary : null;
}

export type SyncPaddleCatalogResult =
  | { readonly ok: true; readonly summary: CatalogSyncSummary }
  | { readonly ok: false; readonly reason: "not_connected" };

/** "Refresh catalog": imports the catalog again. Needs `workspace.manage`. */
export async function syncPaddleCatalog(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  deps: CommerceDeps,
): Promise<SyncPaddleCatalogResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const connection = await repo.getPaddleConnection(ctx.db, { workspaceId: scope.workspaceId });
  const summary =
    connection === null ? null : await importCatalog(ctx, deps, connection, asAuditActor(actor));
  return summary === null ? { ok: false, reason: "not_connected" } : { ok: true, summary };
}

/** A catalog price as the billing and offer pages show it. */
export interface CatalogPrice {
  readonly priceId: string;
  readonly productId: string;
  readonly productName: string;
  readonly description: string | null;
  /** Null for a one-time price, which offers cannot sell. */
  readonly billingInterval: PaddleBillingInterval | null;
  readonly billingFrequency: number | null;
  /** Minor units, as Paddle's decimal string. */
  readonly unitAmount: string;
  readonly currency: string;
  readonly status: PaddlePriceStatus;
}

export const catalogPrice = (price: repo.PaddlePrice): CatalogPrice => ({
  priceId: price.priceId,
  productId: price.productId,
  productName: price.productName,
  description: price.description,
  billingInterval: price.billingInterval,
  billingFrequency: price.billingFrequency,
  unitAmount: price.unitAmount,
  currency: price.currency,
  status: price.status,
});

export interface BillingView {
  /** The live connection, or null when the workspace has none. */
  readonly connection: {
    readonly id: string;
    readonly status: LiveStatus;
    readonly statusReason: string | null;
    readonly environment: PaddleEnvironment;
    readonly sellerId: string;
    readonly sellerName: string | null;
    readonly apiKeyExpiresOn: Instant | null;
    /** From 14 days before the key's expiry date (decision 0011). */
    readonly keyExpiresSoon: boolean;
    readonly destinationId: string;
    /** A webhook secret rotation started and has not completed: both secrets are accepted. */
    readonly rotationInProgress: boolean;
    /** When the last signed webhook arrived. */
    readonly lastEventAt: Instant | null;
    readonly lastCheckedAt: Instant | null;
    readonly catalogSyncedAt: Instant | null;
    readonly connectedAt: Instant;
  } | null;
  /** The live connection's catalog, by product then price. */
  readonly prices: readonly CatalogPrice[];
}

/** The billing page. Needs `workspace.manage`: it is the owner's. */
export async function getBillingView(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<BillingView> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const [connection, prices] = await Promise.all([
    repo.getPaddleConnection(context.db, { workspaceId }),
    repo.listPaddlePrices(context.db, { workspaceId }),
  ]);
  const now = context.clock.now();
  return {
    connection:
      connection === null
        ? null
        : {
            id: connection.id,
            status: connection.status as LiveStatus,
            statusReason: connection.statusReason,
            environment: connection.environment,
            sellerId: connection.sellerId,
            sellerName: connection.sellerName,
            apiKeyExpiresOn: connection.apiKeyExpiresOn,
            keyExpiresSoon:
              connection.apiKeyExpiresOn !== null &&
              now >= connection.apiKeyExpiresOn - PADDLE_KEY_EXPIRY_WARNING_MS,
            destinationId: connection.destinationId as string,
            rotationInProgress: connection.destinationNextId !== null,
            lastEventAt: connection.lastEventAt,
            lastCheckedAt: connection.lastCheckedAt,
            catalogSyncedAt: connection.catalogSyncedAt,
            connectedAt: connection.createdAt,
          },
    prices: prices.map(catalogPrice),
  };
}

// Webhooks -------------------------------------------------------------------------------------

export type PaddleWebhookResult =
  /** No such connection, or it is disconnected: 404. */
  | { readonly status: "not_found" }
  /** The signature does not verify under the connection's secret: 401, nothing stored. */
  | { readonly status: "invalid_signature" }
  /** Signed, but not a Paddle envelope ShareRepo understands: 400, nothing stored. */
  | { readonly status: "malformed" }
  /** Recorded; `outboxId` is the processing intent to hand to the queue. */
  | { readonly status: "accepted"; readonly eventId: string; readonly outboxId: string }
  /** Already recorded (a retry or a replay): 200, nothing written. */
  | { readonly status: "duplicate"; readonly eventId: string };

/** The subscription an event concerns, which processing refreshes; null for other entities. */
function subscriptionOf(envelope: PaddleEnvelope): string | null {
  const [entity] = envelope.eventType.split(".");
  if (entity === "subscription") return envelope.entityId;
  return entity === "transaction" ? envelope.subscriptionId : null;
}

/**
 * Receives a delivery to `/webhooks/paddle/:connectionId` (decision 0011). The connection named
 * by the URL selects the secret (and, while a webhook secret rotation is in progress, the next
 * secret too: a delivery signed under either is accepted); the signature is verified on the raw
 * body before anything is parsed or stored. A query string, such as a rotated destination's
 * `?v=` marker, plays no part. The receipt (metadata, the subscription ID and a digest, never the payload)
 * and its processing intent are recorded in one batch, deduplicated per connection by `evt_` ID.
 */
export async function ingestPaddleWebhook(
  context: ServiceContext,
  input: {
    readonly connectionId: string;
    readonly rawBody: ArrayBuffer;
    readonly signatureHeader: string | null;
  },
  deps: Pick<CommerceDeps, "credentialKeys">,
): Promise<PaddleWebhookResult> {
  const ctx = atOneInstant(context);
  const connection = await repo.getPaddleConnectionForWebhook(ctx.db, input.connectionId);
  if (connection === null || connection.status === "disconnected") return { status: "not_found" };
  const envelope = connection.webhookSecretEnvelope as string;
  const nextEnvelope = connection.webhookSecretNextEnvelope;
  const secrets = [await openCredential(ctx, deps, connection, "webhook_secret", envelope)];
  if (nextEnvelope !== null) {
    secrets.push(await openCredential(ctx, deps, connection, "webhook_secret_next", nextEnvelope));
  }
  const now = ctx.clock.now();
  const verified = await verifyPaddleSignature({
    header: input.signatureHeader,
    rawBody: input.rawBody,
    secrets,
    now,
  });
  if (!verified.ok) return { status: "invalid_signature" };
  let event: PaddleEnvelope;
  try {
    event = parsePaddleEnvelope(JSON.parse(new TextDecoder().decode(input.rawBody)));
  } catch {
    return { status: "malformed" };
  }

  const eventId = ctx.ids.next();
  const outboxId = ctx.ids.next();
  const { workspaceId, id: connectionId } = connection;
  const result = await repo.recordExternalEvent(
    ctx.db,
    {
      id: eventId,
      provider: "paddle",
      connectionId,
      externalEventId: event.eventId,
      eventType: event.eventType,
      action: null,
      installationId: null,
      externalSubscriptionId: subscriptionOf(event),
      payloadDigest: await payloadDigest(input.rawBody),
      occurredAt: event.occurredAt,
      receivedAt: now,
    },
    [
      {
        id: outboxId,
        kind: OutboxKind.ProcessExternalEvent,
        subjectId: eventId,
        createdAt: now,
        availableAt: now,
        workspaceId,
      },
    ],
  );
  await repo.markPaddleEventReceived(ctx.db, { workspaceId, connectionId, now });
  return result.inserted
    ? { status: "accepted", eventId, outboxId }
    : { status: "duplicate", eventId: result.eventId };
}

/**
 * Processes a recorded Paddle event as a hint, never trusting its state (Phase 5 plan):
 * `subscription.*` and `transaction.*` events with a subscription queue a deduplicated
 * `refresh_subscription`; `api_key.*` events queue a `check_paddle_connection` (their payloads do
 * not say which key); anything else, and events of a disconnected connection, are ignored. Safe
 * to run any number of times.
 */
export async function processPaddleEvent(
  context: ServiceContext,
  eventId: string,
): Promise<ProcessEventOutcome> {
  const ctx = atOneInstant(context);
  const event = await repo.getExternalEvent(ctx.db, eventId);
  if (
    event === null ||
    event.processingState === "processed" ||
    event.processingState === "ignored"
  ) {
    return "already_done";
  }
  const now = ctx.clock.now();
  // A GitHub event names no connection, so it finds none here.
  const connection = await repo.getPaddleConnectionForWebhook(ctx.db, event.connectionId ?? "");
  let work: repo.NewOutboxRow | null = null;
  if (connection !== null && connection.status !== "disconnected") {
    const { workspaceId } = connection;
    if (event.externalSubscriptionId !== null) {
      work = refreshOutboxRow(ctx, {
        workspaceId,
        source: "paddle",
        externalSubscriptionId: event.externalSubscriptionId,
      });
    } else if (event.eventType.startsWith("api_key.")) {
      work = {
        id: ctx.ids.next(),
        kind: OutboxKind.CheckPaddleConnection,
        subjectId: encodePaddleConnectionKey({ workspaceId, connectionId: connection.id }),
        createdAt: now,
        availableAt: now,
        workspaceId,
      };
    }
  }
  if (work === null) {
    await repo.markExternalEvent(ctx.db, { id: eventId, state: "ignored", now });
    return "ignored";
  }
  await repo.enqueueOutboxOnce(ctx.db, work);
  await repo.markExternalEvent(ctx.db, { id: eventId, state: "processed", now });
  return "processed";
}

// The entitlement source -----------------------------------------------------------------------

/**
 * The Paddle entitlement source (Phase 5 plan): reads a subscription through the workspace's
 * active connection and normalizes it. A subscription Paddle does not know is `found: false`. No
 * active connection, or a refused key, fails as `PaddleUnavailableError`, so the refresh writes
 * nothing and the outbox retries. The customer link is never decided from Paddle's data: the
 * refresh verifies the claim reference instead, and lists the customer's subscriptions so a
 * customer is linked only when all of them came through the checkout (decision 0012).
 */
export function paddleEntitlementSource(
  ctx: ServiceContext,
  deps: CommerceDeps,
): EntitlementSourcePort {
  const connected = async (workspaceId: string) => {
    const connection = await activePaddleConnection(ctx, workspaceId);
    if (connection === null) throw new PaddleUnavailableError("no active Paddle connection");
    return connection;
  };
  return {
    source: "paddle",
    checkoutClaims: {
      signingKeys: Object.values(deps.claimSigningKeys.keys),
      async customerPurchases({ workspaceId, externalCustomerId }) {
        const connection = await connected(workspaceId);
        const list = await withPaddle(ctx, deps, connection, (client) =>
          client.listCustomerSubscriptions(externalCustomerId),
        );
        return {
          subscriptions: list.subscriptions.map((sub) => ({
            externalSubscriptionId: sub.id,
            externalCustomerId: sub.customerId,
            claimReference: sub.claimReference,
          })),
          truncated: list.truncated,
        };
      },
    },
    async refreshSubscription({ workspaceId, externalSubscriptionId }) {
      const connection = await connected(workspaceId);
      let subscription: PaddleSubscription;
      try {
        subscription = await withPaddle(ctx, deps, connection, (client) =>
          client.getSubscription(externalSubscriptionId),
        );
      } catch (error) {
        if (error instanceof PaddleApiError && error.kind === "not_found") return { found: false };
        throw error;
      }
      const { snapshot, claimReference } = normalizePaddleSubscription(subscription);
      return { found: true, snapshot, customerLink: null, claimReference };
    },
  };
}

// Repair ---------------------------------------------------------------------------------------

/**
 * The daily repair for one connection (Phase 5 plan): lists the seller's subscriptions and queues
 * a deduplicated refresh for each one ShareRepo does not store, or stores with an older
 * `updated_at`, so events lost after Paddle's retries are recovered. Null when the connection is
 * not active.
 */
export async function sweepPaddleSubscriptions(
  context: ServiceContext,
  ref: PaddleConnectionRef,
  deps: CommerceDeps,
): Promise<{ readonly queued: number; readonly truncated: boolean } | null> {
  const ctx = atOneInstant(context);
  const connection = await namedConnection(ctx, ref);
  if (connection?.status !== "active") return null;
  const { workspaceId } = ref;
  const list = await withPaddle(ctx, deps, connection, (client) => client.listSubscriptions());
  const stored = await repo.listSubscriptionSourceVersions(ctx.db, {
    workspaceId,
    source: "paddle",
  });
  let queued = 0;
  for (const subscription of list.subscriptions) {
    const known = stored.get(subscription.id);
    if (known !== undefined && known >= subscription.updatedAt) continue;
    const row = refreshOutboxRow(ctx, {
      workspaceId,
      source: "paddle",
      externalSubscriptionId: subscription.id,
    });
    if (await repo.enqueueOutboxOnce(ctx.db, row)) queued += 1;
  }
  return { queued, truncated: list.truncated };
}

/**
 * The daily cron: queues a `sweep_paddle_subscriptions` for each active connection, once. Each
 * becomes available at its connection's own offset into the day (`dailyOffsetMs`), so the sweeps
 * spread over the day instead of all calling Paddle at once (phase-6 plan § Partitioning).
 */
export async function queuePaddleSweeps(context: ServiceContext): Promise<number> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  let queued = 0;
  for (const connection of await repo.listActivePaddleConnections(ctx.db)) {
    const row: repo.NewOutboxRow = {
      id: ctx.ids.next(),
      kind: OutboxKind.SweepPaddleSubscriptions,
      subjectId: encodePaddleConnectionKey({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
      }),
      createdAt: now,
      availableAt: now + dailyOffsetMs(OutboxKind.SweepPaddleSubscriptions, connection.id),
      workspaceId: connection.workspaceId,
    };
    if (await repo.enqueueOutboxOnce(ctx.db, row)) queued += 1;
  }
  return queued;
}
