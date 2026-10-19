import * as repo from "@sharerepo/db";
import {
  type AuditDetails,
  type AuditEvent,
  type AuditEventInput,
  auditEvent,
  type ConnectionStatus,
  connectionStatusFor,
  GITHUB_PERSONAL_REPOSITORY_CAPABILITIES,
  isSellable,
  type ObservedRepository,
  OutboxKind,
  planResourceSync,
  type ResourceChanges,
  type ResourceSelection,
  roleAllows,
} from "@sharerepo/domain";
import {
  GitHubApiError,
  type GitHubAppPort,
  type GitHubInstallation,
  parseWebhookEnvelope,
  payloadDigest,
  verifyWebhookSignature,
} from "@sharerepo/integrations";
import { ConflictError } from "@sharerepo/platform";
import {
  asAuditActor,
  atOneInstant,
  type ServiceContext,
  type UserActor,
  type WorkspaceAuditAction,
} from "./context.ts";
import { reconcileOutboxRow } from "./reconciliation.ts";
import { openWorkspace } from "./workspaces.ts";

// GitHub App connections (Phase 2 plan): an intent binds an installation to a workspace and user;
// webhooks are hints that trigger a resync from GitHub's current state.

/** How long a "Connect GitHub" intent stays usable. */
export const CONNECTION_INTENT_TTL_MS = 15 * 60 * 1000;

const SYSTEM = { type: "system", id: null } as const;

/** 256 random bits, base64url: the `state` GitHub returns to the setup callback. */
function newIntentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type StartConnectionResult =
  | { readonly ok: true; readonly installUrl: string }
  | { readonly ok: false; readonly reason: "acknowledgement_required" };

/**
 * Starts "Connect GitHub" for a workspace the actor manages. The creator must acknowledge that
 * subscribers will get write access (decision 0008); the acknowledgement is stored and audited.
 */
export async function startGitHubConnection(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly acknowledgeWriteAccess: boolean },
  github: GitHubAppPort,
): Promise<StartConnectionResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  if (!input.acknowledgeWriteAccess) return { ok: false, reason: "acknowledgement_required" };

  const token = newIntentToken();
  const now = ctx.clock.now();
  const id = ctx.ids.next();
  await repo.createConnectionIntent(
    ctx.db,
    {
      id,
      workspaceId: scope.workspaceId,
      userId: actor.userId,
      tokenHash: await sha256Hex(token),
      writeAccessAcknowledgedAt: now,
      createdAt: now,
      expiresAt: now + CONNECTION_INTENT_TTL_MS,
    },
    [
      auditEvent(
        "connection.intent_created",
        {
          workspaceId: scope.workspaceId,
          actor: asAuditActor(actor),
          targetId: id,
          details: { provider: "github" },
        },
        ctx,
      ),
    ],
  );
  return { ok: true, installUrl: github.installUrl(token) };
}

export type CompleteConnectionFailure =
  /** Unknown, used, expired, or someone else's intent; or a malformed installation ID. */
  | "invalid_state"
  /** The actor can no longer manage the intent's workspace. */
  | "not_owner"
  | "installation_not_found"
  /** Organization or enterprise accounts are not supported in v1 (decision 0008). */
  | "account_not_supported"
  /** The installation's account is not the actor's linked GitHub account. */
  | "account_mismatch"
  /** The installation already belongs to another workspace. */
  | "installation_taken";

export type CompleteConnectionResult =
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly workspaceSlug: string;
      readonly connectionId: string;
    }
  | { readonly ok: false; readonly reason: CompleteConnectionFailure };

const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;

/**
 * GitHub's setup callback. Attaches the installation only if the `state` is the actor's own,
 * unexpired, unused intent; the actor still manages its workspace; and the installation (read
 * from GitHub, never trusted from the query) is on the actor's own personal GitHub account and
 * not attached elsewhere. Consuming the intent, creating the connection, its audit event and the
 * first resync's outbox row are one batch.
 */
export async function completeGitHubConnection(
  context: ServiceContext,
  actor: UserActor,
  input: { readonly state: string; readonly installationId: string },
  github: GitHubAppPort,
): Promise<CompleteConnectionResult> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const fail = (reason: CompleteConnectionFailure) => ({ ok: false, reason }) as const;

  if (!INSTALLATION_ID.test(input.installationId)) return fail("invalid_state");
  const intent = await repo.findConnectionIntentByTokenHash(ctx.db, await sha256Hex(input.state));
  if (
    intent === null ||
    intent.userId !== actor.userId ||
    intent.consumedAt !== null ||
    intent.expiresAt <= now
  ) {
    return fail("invalid_state");
  }
  const membership = await repo.getWorkspaceForMember(ctx.db, {
    workspaceId: intent.workspaceId,
    userId: actor.userId,
  });
  if (membership === null || !roleAllows(membership.role, "workspace.manage")) {
    return fail("not_owner");
  }

  let installation: GitHubInstallation;
  try {
    installation = await github.getInstallation(input.installationId);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === "not_found") {
      return fail("installation_not_found");
    }
    throw error;
  }
  if (installation.account.type !== "User") return fail("account_not_supported");
  const identity = await repo.findExternalIdentityForUser(ctx.db, {
    userId: actor.userId,
    provider: "github",
  });
  if (identity?.externalUserId !== installation.account.id) return fail("account_mismatch");

  const workspaceSlug = membership.workspace.slug;
  const existing = await repo.findConnectionByInstallationId(ctx.db, installation.id);
  if (existing?.workspaceId === intent.workspaceId) {
    // GitHub calls the setup URL again after the owner changes the repository selection.
    return { ok: true, workspaceId: intent.workspaceId, workspaceSlug, connectionId: existing.id };
  }
  // An installation attached to another workspace is refused by the unique installation ID.

  const connectionId = ctx.ids.next();
  const result = await repo.createConnectionFromIntent(
    ctx.db,
    {
      intentId: intent.id,
      now,
      connection: {
        id: connectionId,
        workspaceId: intent.workspaceId,
        provider: "github",
        installationId: installation.id,
        accountExternalId: installation.account.id,
        accountLoginSnapshot: installation.account.login,
        accountType: "user",
        status: connectionStatusFor(installation),
        permissions: JSON.stringify(installation.permissions),
        writeAccessAcknowledgedAt: intent.writeAccessAcknowledgedAt,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: null,
        syncVersion: 0,
        syncToken: null,
      },
      outbox: [
        {
          id: ctx.ids.next(),
          kind: OutboxKind.ResyncConnection,
          subjectId: connectionId,
          createdAt: now,
          availableAt: now,
        },
      ],
    },
    [
      auditEvent(
        "connection.created",
        {
          workspaceId: intent.workspaceId,
          actor: asAuditActor(actor),
          targetId: connectionId,
          details: {
            provider: "github",
            installationId: installation.id,
            accountLogin: installation.account.login,
          },
        },
        ctx,
      ),
    ],
  );
  if (!result.ok) {
    return fail(result.reason === "installation_taken" ? "installation_taken" : "invalid_state");
  }
  return { ok: true, workspaceId: intent.workspaceId, workspaceSlug, connectionId };
}

/**
 * GitHub's setup callback after the owner changed the repository selection on GitHub: it
 * carries no `state`. If the installation is already connected to a workspace the actor manages,
 * resync it and return that workspace; otherwise null (nothing is attached without an intent).
 */
export async function refreshInstallationForMember(
  context: ServiceContext,
  actor: UserActor,
  installationId: string,
  github: GitHubAppPort,
): Promise<{ readonly workspaceSlug: string } | null> {
  if (!INSTALLATION_ID.test(installationId)) return null;
  const connection = await repo.findConnectionByInstallationId(context.db, installationId);
  if (connection === null) return null;
  const membership = await repo.getWorkspaceForMember(context.db, {
    workspaceId: connection.workspaceId,
    userId: actor.userId,
  });
  // A resync changes state, so it needs the same permission as "Refresh from GitHub".
  if (membership === null || !roleAllows(membership.role, "workspace.manage")) return null;
  await resyncConnection(
    context,
    connection,
    github,
    "selection changed on GitHub",
    asAuditActor(actor),
  );
  return { workspaceSlug: membership.workspace.slug };
}

export type WebhookIngestResult =
  | { readonly status: "rejected" }
  /** Recorded; `outboxId` is the processing intent to hand to the queue. */
  | { readonly status: "accepted"; readonly eventId: string; readonly outboxId: string }
  | { readonly status: "duplicate"; readonly eventId: string };

/**
 * Receives a GitHub webhook. The signature is verified on the raw body before anything is parsed
 * or stored. The receipt (metadata and a digest, never the payload) and its processing intent are
 * recorded in one batch; a redelivery records nothing.
 */
export async function ingestGitHubWebhook(
  context: ServiceContext,
  input: { readonly secret: string; readonly rawBody: ArrayBuffer; readonly headers: Headers },
): Promise<WebhookIngestResult> {
  const signature = input.headers.get("x-hub-signature-256");
  if (!(await verifyWebhookSignature(input.secret, input.rawBody, signature))) {
    return { status: "rejected" };
  }
  let envelope: ReturnType<typeof parseWebhookEnvelope>;
  try {
    envelope = parseWebhookEnvelope(
      input.headers,
      JSON.parse(new TextDecoder().decode(input.rawBody)),
    );
  } catch {
    // Signed by GitHub but not a webhook we understand (invalid JSON or envelope).
    return { status: "rejected" };
  }

  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const eventId = ctx.ids.next();
  const outboxId = ctx.ids.next();
  const result = await repo.recordExternalEvent(
    ctx.db,
    {
      id: eventId,
      provider: "github",
      externalEventId: envelope.deliveryId,
      eventType: envelope.event,
      action: envelope.action,
      installationId: envelope.installationId,
      payloadDigest: await payloadDigest(input.rawBody),
      receivedAt: now,
    },
    [
      {
        id: outboxId,
        kind: OutboxKind.ProcessExternalEvent,
        subjectId: eventId,
        createdAt: now,
        availableAt: now,
      },
    ],
  );
  return result.inserted
    ? { status: "accepted", eventId, outboxId }
    : { status: "duplicate", eventId: result.eventId };
}

/** Events that can change an installation's status or repositories; all others are ignored. */
const RESYNC_EVENTS = new Set(["installation", "installation_repositories", "repository"]);

export type ProcessEventOutcome = "processed" | "ignored" | "already_done";

/**
 * Processes a recorded webhook as a hint: re-reads the installation from GitHub and converges
 * the stored connection and resources. Safe to run any number of times, in any order. Retryable
 * GitHub failures are recorded and rethrown so the queue retries.
 */
export async function processExternalEvent(
  context: ServiceContext,
  eventId: string,
  github: GitHubAppPort,
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
  const connection =
    event.installationId !== null && RESYNC_EVENTS.has(event.eventType)
      ? await repo.findConnectionByInstallationId(ctx.db, event.installationId)
      : null;
  if (connection === null) {
    await repo.markExternalEvent(ctx.db, { id: eventId, state: "ignored", now });
    return "ignored";
  }
  try {
    await resyncConnection(ctx, connection, github, `github webhook: ${event.eventType}`);
  } catch (error) {
    await repo.markExternalEvent(ctx.db, {
      id: eventId,
      state: "failed",
      now,
      errorCode: error instanceof GitHubApiError ? error.kind : "internal_error",
    });
    throw error;
  }
  await repo.markExternalEvent(ctx.db, { id: eventId, state: "processed", now });
  return "processed";
}

export interface ResyncSummary {
  readonly status: ConnectionStatus;
  readonly discovered: number;
  readonly updated: number;
  readonly removed: number;
}

/**
 * Converges a connection with GitHub's current state. A deleted installation marks the
 * connection deleted and every resource removed; a suspended one keeps its resources but cannot
 * be listed; otherwise the selected repositories are upserted by immutable ID and the rest marked
 * removed. Always records `connection.synced`.
 */
export async function resyncConnection(
  context: ServiceContext,
  connection: { readonly workspaceId: string; readonly id: string },
  github: GitHubAppPort,
  reason: string,
  actor: AuditEvent["actor"] = SYSTEM,
): Promise<ResyncSummary> {
  // Concurrent resyncs (webhook, outbox, daily, manual) each read, call GitHub, then write with a
  // version check. A stale one writes nothing and starts again from fresh state.
  for (let attempt = 1; ; attempt += 1) {
    const result = await attemptResync(context, connection, github, reason, actor);
    if (result !== "stale") return result;
    if (attempt === MAX_RESYNC_ATTEMPTS) {
      throw new ConflictError("connection kept changing during resync; retry later");
    }
  }
}

const MAX_RESYNC_ATTEMPTS = 3;

async function attemptResync(
  context: ServiceContext,
  connection: { readonly workspaceId: string; readonly id: string },
  github: GitHubAppPort,
  reason: string,
  actor: AuditEvent["actor"],
): Promise<ResyncSummary | "stale"> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const stored = await repo.getConnection(ctx.db, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
  });
  if (stored === null) throw new ConflictError("connection not found for resync");
  if (stored.status === "deleted") {
    return { status: "deleted", discovered: 0, updated: 0, removed: 0 };
  }

  let installation: GitHubInstallation | null;
  try {
    installation = await github.getInstallation(stored.installationId);
  } catch (error) {
    if (!(error instanceof GitHubApiError && error.kind === "not_found")) throw error;
    installation = null;
  }
  const status: ConnectionStatus =
    installation === null ? "deleted" : connectionStatusFor(installation);

  const current = await repo.listResourcesForConnection(ctx.db, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
  });
  let observed: ObservedRepository[];
  if (installation === null) {
    observed = [];
  } else if (status === "suspended") {
    // A suspended installation cannot be listed: keep the selection until it resumes.
    observed = current.filter((resource) => resource.selection === "selected").map(asObserved);
  } else {
    const accountId = installation.account.id;
    observed = (await github.listInstallationRepositories(stored.installationId))
      .filter((repository) => repository.ownerExternalId === accountId)
      .map(({ externalId, name, ownerExternalId, private: isPrivate, archived }) => ({
        externalId,
        name,
        ownerExternalId,
        private: isPrivate,
        archived,
      }));
  }
  const plan = planResourceSync(
    current.map((resource) => ({
      id: resource.id,
      externalId: resource.externalId,
      name: resource.nameSnapshot,
      ownerExternalId: resource.ownerExternalId,
      private: resource.private,
      archived: resource.archived,
      selection: resource.selection,
    })),
    observed,
  );

  const workspaceId = connection.workspaceId;
  // Every resync event is workspace-scoped, by the resync's actor, with the trigger as its reason.
  const event = <A extends WorkspaceAuditAction>(
    action: A,
    targetId: string,
    details: AuditDetails<A>,
  ): AuditEvent =>
    auditEvent(
      action,
      // TypeScript cannot resolve WorkspaceField<A> for a generic A; A is workspace-scoped here.
      { workspaceId, actor, targetId, reason, details } as unknown as AuditEventInput<A>,
      ctx,
    );
  const audit: AuditEvent[] = [];
  const inserts: repo.Resource[] = plan.discovered.map((found) => {
    const id = ctx.ids.next();
    audit.push(
      event("resource.discovered", id, {
        externalId: found.externalId,
        name: found.name,
        private: found.private,
      }),
    );
    return {
      id,
      workspaceId,
      connectionId: connection.id,
      provider: "github",
      type: "repository",
      externalId: found.externalId,
      nameSnapshot: found.name,
      ownerExternalId: found.ownerExternalId,
      private: found.private,
      archived: found.archived,
      selection: "selected",
      capabilities: JSON.stringify(GITHUB_PERSONAL_REPOSITORY_CAPABILITIES),
      discoveredAt: now,
      updatedAt: now,
      nextReconcileAt: null,
      lastReconciledAt: null,
      reconcileToken: null,
      reconcileLeaseUntil: null,
    };
  });
  const updates = new Map<string, repo.ResourceChanges>();
  for (const { id, externalId, changes } of plan.updated) {
    audit.push(event("resource.updated", id, { externalId, changes }));
    updates.set(
      id,
      Object.fromEntries(
        Object.entries(changes).map(([field, change]) => [
          CHANGE_COLUMNS[field as keyof ResourceChanges],
          change.to,
        ]),
      ),
    );
  }
  for (const { id, externalId, from, to } of plan.selectionChanged) {
    audit.push(
      event("resource.selection_changed", id, {
        externalId,
        previousSelection: from,
        selection: to,
      }),
    );
    updates.set(id, { ...updates.get(id), selection: to satisfies ResourceSelection });
  }
  if (status !== stored.status) {
    audit.push(
      event("connection.status_changed", connection.id, {
        previousStatus: stored.status,
        status,
      }),
    );
  }
  // Reconcile every repository whose eligibility may have changed: its selection, privacy or
  // archive state, or, when the connection's status changed, every repository of the connection.
  const affected = new Set(
    status === stored.status
      ? [
          ...plan.updated
            .filter(
              ({ changes }) => changes.private !== undefined || changes.archived !== undefined,
            )
            .map(({ id }) => id),
          ...plan.selectionChanged.map(({ id }) => id),
        ]
      : current.map((resource) => resource.id),
  );
  const summary = {
    status,
    discovered: plan.discovered.length,
    updated: plan.updated.length,
    removed: plan.selectionChanged.filter((change) => change.to === "removed").length,
  };
  audit.push(
    event("connection.synced", connection.id, {
      discovered: summary.discovered,
      updated: summary.updated,
      removed: summary.removed,
    }),
  );

  const result = await repo.applyResourceSync(
    ctx.db,
    {
      workspaceId,
      connectionId: connection.id,
      now,
      expectedVersion: stored.syncVersion,
      syncToken: ctx.ids.next(),
      inserts,
      updates: [...updates].map(([id, set]) => ({ id, set })),
      reconcile: [...affected]
        .sort()
        .map((resourceId) => reconcileOutboxRow(ctx, { workspaceId, resourceId })),
      connection: {
        status,
        ...(installation === null
          ? {}
          : {
              permissions: JSON.stringify(installation.permissions),
              accountLoginSnapshot: installation.account.login,
            }),
      },
    },
    audit as [AuditEvent, ...AuditEvent[]],
  );
  return result.ok ? summary : "stale";
}

/** Where each planned change is stored on the resource row. */
const CHANGE_COLUMNS = {
  name: "nameSnapshot",
  ownerExternalId: "ownerExternalId",
  private: "private",
  archived: "archived",
} as const satisfies Record<keyof ResourceChanges, keyof repo.ResourceChanges>;

const asObserved = (resource: repo.Resource): ObservedRepository => ({
  externalId: resource.externalId,
  name: resource.nameSnapshot,
  ownerExternalId: resource.ownerExternalId,
  private: resource.private,
  archived: resource.archived,
});

export interface RepositorySummary {
  readonly id: string;
  readonly name: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly selection: ResourceSelection;
  readonly sellable: boolean;
}

export interface ConnectionSummary {
  readonly id: string;
  readonly accountLogin: string;
  readonly status: ConnectionStatus;
  readonly lastSyncedAt: number | null;
  readonly repositories: readonly RepositorySummary[];
}

/** The workspace's GitHub connections and their repositories, for any member. */
export async function listGitHubConnections(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<ConnectionSummary[]> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.read");
  const connections = await repo.listConnectionsForWorkspace(context.db, scope.workspaceId);
  return Promise.all(
    connections.map(async (connection) => {
      const resources = await repo.listResourcesForConnection(context.db, {
        workspaceId: scope.workspaceId,
        connectionId: connection.id,
      });
      return {
        id: connection.id,
        accountLogin: connection.accountLoginSnapshot,
        status: connection.status,
        lastSyncedAt: connection.lastSyncedAt,
        repositories: resources.map((resource) => ({
          id: resource.id,
          name: resource.nameSnapshot,
          private: resource.private,
          archived: resource.archived,
          selection: resource.selection,
          sellable: isSellable(resource, connection.status),
        })),
      };
    }),
  );
}

/** Resyncs every connection of a workspace the actor manages, now. */
export async function resyncWorkspaceConnections(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  github: GitHubAppPort,
): Promise<void> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.manage");
  const connections = await repo.listConnectionsForWorkspace(context.db, scope.workspaceId);
  for (const connection of connections) {
    if (connection.status !== "deleted") {
      await resyncConnection(context, connection, github, "requested", asAuditActor(actor));
    }
  }
}
