import {
  appendAuditEvents,
  createUser,
  findExternalIdentity,
  insertExternalIdentity,
  updateExternalIdentitySnapshot,
} from "@sharerepo/db";
import {
  auditEvent,
  type GitHubLogin,
  type GitHubUserId,
  type IdentityProvider,
  type SignInRefusalReason,
} from "@sharerepo/domain";
import { ConflictError } from "@sharerepo/platform";
import { asAuditActor, atOneInstant, type ServiceContext, type UserActor } from "./context.ts";

/** A verified provider profile, fetched from the provider during this sign-in. */
export interface ProviderProfile {
  readonly provider: IdentityProvider;
  readonly externalUserId: GitHubUserId;
  readonly username: GitHubLogin;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

/**
 * Creates the ShareRepo user for a first sign-in, before the auth library stores its own profile
 * row with the same ID (decision 0006).
 */
export async function createUserForSignIn(context: ServiceContext): Promise<{ userId: string }> {
  const ctx = atOneInstant(context);
  const userId = ctx.ids.next();
  const created = auditEvent(
    "user.created",
    { actor: { type: "user", id: userId }, targetId: userId, details: {} },
    ctx,
  );
  await createUser(ctx.db, { id: userId, now: ctx.clock.now() }, [created]);
  return { userId };
}

/** `linked`: first sign-in with this account; `renamed`: the username changed; else `refreshed`. */
export type SignInOutcome = "linked" | "renamed" | "refreshed";

/**
 * Records a completed sign-in: links the provider identity on first use, otherwise refreshes its
 * snapshot. The identity is keyed by the provider's immutable user ID, so a username change
 * updates the existing identity and never creates a new one.
 */
export async function recordSignIn(
  context: ServiceContext,
  actor: UserActor,
  profile: ProviderProfile,
): Promise<{ identityId: string; outcome: SignInOutcome }> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const audit = (targetId: string) => ({ actor: asAuditActor(actor), targetId });
  const signedIn = auditEvent(
    "auth.signed_in",
    { ...audit(actor.userId), details: { provider: profile.provider } },
    ctx,
  );
  const snapshot = {
    usernameSnapshot: profile.username,
    displayNameSnapshot: profile.displayName,
    avatarUrlSnapshot: profile.avatarUrl,
    verifiedAt: now,
  };

  let existing = await findExternalIdentity(ctx.db, profile);
  if (existing === null) {
    const identity = {
      id: ctx.ids.next(),
      userId: actor.userId,
      provider: profile.provider,
      externalUserId: profile.externalUserId,
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    };
    const linked = auditEvent(
      "identity.linked",
      {
        ...audit(identity.id),
        details: {
          provider: profile.provider,
          externalUserId: profile.externalUserId,
          username: profile.username,
        },
      },
      ctx,
    );
    const result = await insertExternalIdentity(ctx.db, identity, [linked, signedIn]);
    if (result.ok) return { identityId: identity.id, outcome: "linked" };
    // The account was deleted while this sign-in ran (decision 0015): refuse it, linking nothing,
    // so a later sign-in creates a new user and links cleanly.
    if (result.reason === "user_deleted") {
      throw new ConflictError("the account was deleted", { code: "account_deleted" });
    }
    // A uniqueness conflict: a concurrent sign-in linked this account first, or the user already
    // has a different account with this provider. Only the first can be read back.
    existing = await findExternalIdentity(ctx.db, profile);
    if (existing === null) {
      throw new ConflictError("user is already linked to a different provider account");
    }
  }

  if (existing.userId !== actor.userId) {
    throw new ConflictError("provider account is linked to a different user");
  }
  const renamed = existing.usernameSnapshot !== profile.username;
  const events = renamed
    ? ([
        auditEvent(
          "identity.snapshot_updated",
          {
            ...audit(existing.id),
            details: {
              provider: profile.provider,
              externalUserId: profile.externalUserId,
              previousUsername: existing.usernameSnapshot,
              username: profile.username,
            },
          },
          ctx,
        ),
        signedIn,
      ] as const)
    : ([signedIn] as const);
  const result = await updateExternalIdentitySnapshot(
    ctx.db,
    { id: existing.id, userId: actor.userId, ...snapshot, now },
    events,
  );
  if (!result.ok) throw new ConflictError("provider account is linked to a different user");
  return { identityId: existing.id, outcome: renamed ? "renamed" : "refreshed" };
}

/**
 * Records a sign-in that authenticated with the provider but was refused, for example because
 * the provider account's identity belongs to another user.
 */
export async function recordSignInRefused(
  context: ServiceContext,
  actor: UserActor,
  input: { readonly provider: IdentityProvider; readonly reason: SignInRefusalReason },
): Promise<void> {
  await appendAuditEvents(context.db, [
    auditEvent(
      "auth.sign_in_refused",
      { actor: asAuditActor(actor), targetId: actor.userId, details: input },
      context,
    ),
  ]);
}

/** Records a sign-out, after the auth library has removed the session. */
export async function recordSignOut(context: ServiceContext, actor: UserActor): Promise<void> {
  const ctx = atOneInstant(context);
  await appendAuditEvents(ctx.db, [
    auditEvent(
      "auth.signed_out",
      { actor: asAuditActor(actor), targetId: actor.userId, details: {} },
      ctx,
    ),
  ]);
}
