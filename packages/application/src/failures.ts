import * as repo from "@sharerepo/db";
import {
  AlertName,
  type AuditEvent,
  auditEvent,
  type Instant,
  OutboxKind,
  parseWorkspaceSlug,
  roleAllows,
  type WorkspaceStatus,
} from "@sharerepo/domain";
import { NotFoundError } from "@sharerepo/platform";
import { type AccessView, accessViewOf } from "./access.ts";
import {
  asAuditActor,
  atOneInstant,
  raiseAlert,
  type ServiceContext,
  type UserActor,
} from "./context.ts";
import {
  decodeOfferKey,
  decodePaddleConnectionKey,
  decodeReconcileKey,
  decodeRefreshKey,
} from "./entitlement-source.ts";
import { openWorkspace } from "./workspaces.ts";

// Failures and operators (decision 0014): failed jobs, repositories that keep failing to
// reconcile and connections that stopped working, for the owner's Access page and the operator's
// `/ops`. Every failure is read and changed within an explicit workspace (null: system-wide).

/** A repository is shown as failing, and alerted once, at this many reconcile failures in a row. */
export const RECONCILE_FAILING_THRESHOLD = 3;
/** At most this many failures of each kind are listed. */
export const FAILURE_LIST_LIMIT = 200;
/** The longest dismissal reason accepted. */
export const DISMISS_REASON_MAX_LENGTH = 500;

const SYSTEM = { type: "system", id: null } as const;

declare const operatorBrand: unique symbol;

/**
 * Proof that the signed-in user is an operator: their linked GitHub account's immutable ID is
 * listed in `OPERATOR_GITHUB_IDS` (decision 0014). Only `authorizeOperator` creates one.
 */
export interface OperatorPrincipal {
  readonly userId: string;
  readonly githubUserId: string;
  readonly [operatorBrand]: true;
}

/**
 * The user as an operator, or null. There is no operator role in the database: only the
 * configured list of GitHub IDs, compared with the user's linked identity, never a login.
 */
export async function authorizeOperator(
  ctx: ServiceContext,
  user: UserActor,
  operatorGitHubIds: ReadonlySet<string>,
): Promise<OperatorPrincipal | null> {
  if (operatorGitHubIds.size === 0) return null;
  const identity = await repo.findExternalIdentityForUser(ctx.db, {
    userId: user.userId,
    provider: "github",
  });
  if (identity === null || !operatorGitHubIds.has(identity.externalUserId)) return null;
  return { userId: user.userId, githubUserId: identity.externalUserId } as OperatorPrincipal;
}

const operatorActor = (operator: OperatorPrincipal): AuditEvent["actor"] => ({
  type: "operator",
  id: operator.userId,
});

/** What a failed job affects, by name, so a person can tell whose access is at stake. */
export interface AffectedAccess {
  readonly repositories: readonly string[];
  readonly subscribers: readonly string[];
  readonly offers: readonly string[];
  /** The GitHub account or Paddle seller whose connection the job is about. */
  readonly connection: { readonly provider: "github" | "paddle"; readonly name: string } | null;
  /** The webhook the job processes: its provider and event type. */
  readonly event: { readonly provider: string; readonly type: string } | null;
}

const NOTHING: AffectedAccess = {
  repositories: [],
  subscribers: [],
  offers: [],
  connection: null,
  event: null,
};

/** A failed job, with what it affects. */
export interface FailedJob {
  readonly id: string;
  /** Null for system-wide work, and for rows queued before migration 0009. */
  readonly workspaceId: string | null;
  readonly workspaceSlug: string | null;
  readonly workspaceName: string | null;
  readonly kind: OutboxKind;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: Instant;
  readonly failedAt: Instant;
  readonly affected: AffectedAccess;
}

/** A selected repository with {@link RECONCILE_FAILING_THRESHOLD} or more failures in a row. */
export type FailingRepository = repo.FailingResource;

/** A key's workspace must be the failure's own, or nothing is resolved from it. */
const ownKey = <T extends { readonly workspaceId: string }>(
  decoded: { ok: true; value: T } | { ok: false },
  workspaceId: string,
): T | null => (decoded.ok && decoded.value.workspaceId === workspaceId ? decoded.value : null);

/**
 * Resolves what a failed job affects from its kind and subject, reading only within the row's
 * own workspace. A system-wide row resolves nothing but its webhook, which is not tenant data.
 */
async function affectedAccess(ctx: ServiceContext, row: repo.OutboxRow): Promise<AffectedAccess> {
  const { db } = ctx;
  if (row.kind === OutboxKind.ProcessExternalEvent) {
    const event = await repo.getExternalEvent(db, row.subjectId);
    return event === null
      ? NOTHING
      : { ...NOTHING, event: { provider: event.provider, type: event.eventType } };
  }
  const workspaceId = row.workspaceId;
  if (workspaceId === null) return NOTHING;
  switch (row.kind) {
    case OutboxKind.ReconcileResource: {
      const key = ownKey(decodeReconcileKey(row.subjectId), workspaceId);
      const resource = key === null ? null : await repo.getResource(db, key);
      return resource === null ? NOTHING : { ...NOTHING, repositories: [resource.nameSnapshot] };
    }
    case OutboxKind.RefreshSubscription: {
      const key = ownKey(decodeRefreshKey(row.subjectId), workspaceId);
      return key === null
        ? NOTHING
        : { ...NOTHING, ...(await repo.subscriptionAccessNames(db, key)) };
    }
    case OutboxKind.RecomputeOffer: {
      const key = ownKey(decodeOfferKey(row.subjectId), workspaceId);
      return key === null ? NOTHING : { ...NOTHING, ...(await repo.offerAccessNames(db, key)) };
    }
    case OutboxKind.ResyncConnection: {
      const connection = await repo.getConnection(db, {
        workspaceId,
        connectionId: row.subjectId,
      });
      return connection === null
        ? NOTHING
        : {
            ...NOTHING,
            connection: { provider: "github", name: connection.accountLoginSnapshot },
          };
    }
    case OutboxKind.CheckPaddleConnection:
    case OutboxKind.SweepPaddleSubscriptions: {
      const key = ownKey(decodePaddleConnectionKey(row.subjectId), workspaceId);
      if (key === null) return NOTHING;
      // The workspace's live connection, when it is still the one the job names.
      const connection = await repo.getPaddleConnection(db, key);
      return connection?.id === key.connectionId
        ? {
            ...NOTHING,
            connection: { provider: "paddle", name: connection.sellerName ?? connection.sellerId },
          }
        : NOTHING;
    }
    default:
      // A claim email, or system work: nothing to name beyond the kind.
      return NOTHING;
  }
}

async function failedJobOf(ctx: ServiceContext, row: repo.OpenOutboxFailure): Promise<FailedJob> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    workspaceName: row.workspaceName,
    kind: row.kind,
    errorCode: row.lastErrorCode,
    attempts: row.attempts,
    createdAt: row.createdAt,
    failedAt: row.failedAt as Instant,
    affected: await affectedAccess(ctx, row),
  };
}

/** A workspace's open failures, for its Access page. */
export interface WorkspaceFailures {
  readonly jobs: readonly FailedJob[];
  readonly repositories: readonly FailingRepository[];
  /** The viewer may retry: an owner of an active workspace. */
  readonly canRetry: boolean;
}

async function failuresOf(ctx: ServiceContext, workspaceId: string) {
  const [rows, repositories] = await Promise.all([
    repo.listOpenOutboxFailures(ctx.db, { workspaceId, limit: FAILURE_LIST_LIMIT }),
    repo.listFailingResources(ctx.db, {
      workspaceId,
      minFailures: RECONCILE_FAILING_THRESHOLD,
      limit: FAILURE_LIST_LIMIT,
    }),
  ]);
  const jobs = await Promise.all(rows.map((row) => failedJobOf(ctx, row)));
  return { jobs, repositories };
}

/**
 * The workspace's open failures, for any member: failed jobs about its subscriptions, offers,
 * repositories and connections (oldest first), and repositories that keep failing to reconcile.
 * Only the workspace's own rows: a system-wide failure is shown on `/ops` only.
 */
export async function listOpenFailures(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<WorkspaceFailures> {
  const ctx = atOneInstant(context);
  const { scope, workspace } = await openWorkspace(ctx, actor, slug, "workspace.read");
  const failures = await failuresOf(ctx, scope.workspaceId);
  // As `openWorkspace` decides for "workspace.manage".
  const canRetry = workspace.status === "active" && roleAllows(workspace.role, "workspace.manage");
  return { ...failures, canRetry };
}

/** Every workspace's failures, for `/ops`. */
export interface OperatorFailures {
  /** Oldest first, system-wide ones included. */
  readonly jobs: readonly FailedJob[];
  readonly repositories: readonly FailingRepository[];
  readonly connections: readonly repo.UnhealthyConnection[];
  readonly sweep: repo.SweepHealth;
}

/**
 * Every open failure, for an operator: failed jobs of every workspace and the system-wide ones,
 * repositories with repeated reconcile failures, unhealthy connections, and sweep health. Each
 * job's affected access is resolved within its own workspace.
 */
export async function listAllOpenFailures(
  context: ServiceContext,
  _operator: OperatorPrincipal,
): Promise<OperatorFailures> {
  const ctx = atOneInstant(context);
  const { db } = ctx;
  const [rows, repositories, connections, sweep] = await Promise.all([
    repo.listOpenOutboxFailures(db, { all: true, limit: FAILURE_LIST_LIMIT }),
    repo.listFailingResources(db, {
      all: true,
      minFailures: RECONCILE_FAILING_THRESHOLD,
      limit: FAILURE_LIST_LIMIT,
    }),
    repo.listUnhealthyConnections(db, { limit: FAILURE_LIST_LIMIT }),
    repo.readSweepHealth(db, ctx.clock.now()),
  ]);
  const jobs = await Promise.all(rows.map((row) => failedJobOf(ctx, row)));
  return { jobs, repositories, connections, sweep };
}

/** A retried job, to hand to the queue at once. */
export interface RetriedFailure {
  readonly outboxId: string;
  readonly kind: OutboxKind;
  readonly subjectId: string;
}

async function retry(
  ctx: ServiceContext,
  key: { readonly outboxId: string; readonly workspaceId: string | null },
  actor: AuditEvent["actor"],
): Promise<RetriedFailure> {
  const row = await repo.getFailedOutboxRow(ctx.db, {
    id: key.outboxId,
    workspaceId: key.workspaceId,
  });
  if (row === null) throw new NotFoundError("no such failure in the workspace");
  const retried = await repo.retryOutboxFailure(
    ctx.db,
    { id: row.id, workspaceId: key.workspaceId, now: ctx.clock.now() },
    [
      auditEvent(
        "job.retried",
        {
          workspaceId: key.workspaceId,
          actor,
          targetId: row.id,
          details: { kind: row.kind, previousErrorCode: row.lastErrorCode ?? "unknown" },
        },
        ctx,
      ),
    ],
  );
  // Retried or sent meanwhile: no longer a failure to retry.
  if (!retried) throw new NotFoundError("failure no longer open");
  return { outboxId: row.id, kind: row.kind, subjectId: row.subjectId };
}

/**
 * An owner retries one of their workspace's failed jobs: it is due again now, with its attempts
 * reset. A failure of another workspace, or a system-wide one, is not found (decision 0014).
 */
export async function retryFailure(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  outboxId: string,
): Promise<RetriedFailure> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  return retry(ctx, { outboxId, workspaceId: scope.workspaceId }, asAuditActor(actor));
}

/** An operator retries a failed job of the named workspace (null: a system-wide one). */
export async function retryFailureAsOperator(
  context: ServiceContext,
  operator: OperatorPrincipal,
  key: { readonly workspaceId: string | null; readonly outboxId: string },
): Promise<RetriedFailure> {
  return retry(atOneInstant(context), key, operatorActor(operator));
}

export type DismissFailureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "reason_required" | "reason_too_long" };

/**
 * An operator dismisses an open failure of the named workspace (null: a system-wide one), with
 * a reason. The row stays, for history, until pruning. Owners cannot dismiss.
 */
export async function dismissFailure(
  context: ServiceContext,
  operator: OperatorPrincipal,
  key: { readonly workspaceId: string | null; readonly outboxId: string; readonly reason: string },
): Promise<DismissFailureResult> {
  const ctx = atOneInstant(context);
  const reason = key.reason.trim();
  if (reason === "") return { ok: false, error: "reason_required" };
  if (reason.length > DISMISS_REASON_MAX_LENGTH) return { ok: false, error: "reason_too_long" };
  const row = await repo.getFailedOutboxRow(ctx.db, {
    id: key.outboxId,
    workspaceId: key.workspaceId,
  });
  if (row === null || row.dismissedAt !== null) {
    throw new NotFoundError("no such open failure in the workspace");
  }
  const dismissed = await repo.dismissOutboxFailure(
    ctx.db,
    {
      id: row.id,
      workspaceId: key.workspaceId,
      now: ctx.clock.now(),
      by: operator.userId,
      reason,
    },
    [
      auditEvent(
        "job.dismissed",
        {
          workspaceId: key.workspaceId,
          actor: operatorActor(operator),
          targetId: row.id,
          reason,
          details: { kind: row.kind, errorCode: row.lastErrorCode ?? "unknown" },
        },
        ctx,
      ),
    ],
  );
  if (!dismissed) throw new NotFoundError("failure no longer open");
  return { ok: true };
}

/** A workspace as an operator reads it: its Access page, read-only, and its open failures. */
export interface OperatorWorkspaceView {
  readonly workspace: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly status: WorkspaceStatus;
  };
  readonly access: AccessView;
  readonly failures: WorkspaceFailures;
}

/**
 * An operator opens a workspace's Access page read-only, audited as `operator.viewed_workspace`
 * (decision 0014). The same scoped reads as the owner's page, with every control disabled.
 */
export async function viewWorkspaceAsOperator(
  context: ServiceContext,
  operator: OperatorPrincipal,
  slug: string,
): Promise<OperatorWorkspaceView> {
  const ctx = atOneInstant(context);
  const parsed = parseWorkspaceSlug(slug);
  const workspace = parsed.ok ? await repo.findWorkspaceBySlug(ctx.db, parsed.value) : null;
  if (workspace === null) throw new NotFoundError("workspace not found");
  const workspaceId = workspace.id;
  await repo.appendAuditEvents(ctx.db, [
    auditEvent(
      "operator.viewed_workspace",
      { workspaceId, actor: operatorActor(operator), targetId: workspaceId, details: {} },
      ctx,
    ),
  ]);
  const [access, failures] = await Promise.all([
    accessViewOf(ctx, workspaceId, false),
    failuresOf(ctx, workspaceId),
  ]);
  return {
    workspace: {
      id: workspaceId,
      slug: workspace.slug,
      name: workspace.name,
      status: workspace.status,
    },
    access,
    failures: { ...failures, canRetry: false },
  };
}

/** A job's terminal failure, as the jobs Worker reports it. */
export interface JobFailure {
  readonly outboxId: string;
  /** A classified code, never a message: an error kind or code, or `dead_lettered`. */
  readonly errorCode: string;
  /**
   * The message's kind and subject, when the failure comes from a queue message: the row must
   * match them, so a forged or stale message cannot fail another row (threat O14).
   */
  readonly message?: { readonly kind: OutboxKind; readonly subjectId: string };
}

/**
 * Records a job's terminal failure (decision 0014): marks its outbox row failed with the code,
 * writes `job.failed` in the row's workspace (account-scoped when it has none), and raises a
 * `job_failed` alert. Only an unsent, unfailed row that matches the message changes, so a replay
 * or a stale or forged message changes nothing. Returns whether the failure was recorded.
 */
export async function recordJobFailure(
  context: ServiceContext,
  failure: JobFailure,
): Promise<boolean> {
  const ctx = atOneInstant(context);
  const row = await repo.getOutboxRow(ctx.db, failure.outboxId);
  if (
    row === null ||
    row.sentAt !== null ||
    row.failedAt !== null ||
    (failure.message !== undefined &&
      (row.kind !== failure.message.kind || row.subjectId !== failure.message.subjectId))
  ) {
    return false;
  }
  const recorded = await repo.failOutboxRow(
    ctx.db,
    { id: row.id, now: ctx.clock.now(), errorCode: failure.errorCode },
    [
      auditEvent(
        "job.failed",
        {
          workspaceId: row.workspaceId,
          actor: SYSTEM,
          targetId: row.id,
          details: {
            kind: row.kind,
            subjectId: row.subjectId,
            errorCode: failure.errorCode,
            attempts: row.attempts,
          },
        },
        ctx,
      ),
    ],
  );
  if (recorded) {
    raiseAlert(ctx, AlertName.JobFailed, {
      outboxId: row.id,
      kind: row.kind,
      errorCode: failure.errorCode,
      attempts: row.attempts,
      ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
    });
  }
  return recorded;
}
