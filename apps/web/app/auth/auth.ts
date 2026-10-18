import {
  createUserForSignIn,
  type ProviderProfile,
  recordSignIn,
  type ServiceContext,
} from "@sharerepo/application";
import { schema } from "@sharerepo/db";
import { ConflictError, type Logger } from "@sharerepo/platform";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { AuthConfig } from "./env.ts";
import type { GitHubClient, GitHubUser } from "./github.ts";

// Better Auth owns login mechanics and its `auth_*` tables; ShareRepo's users and identities are
// written by application services from the hooks below (decision 0006). One instance per request:
// the profile captured during this request's OAuth callback is per-request state.

export const AUTH_BASE_PATH = "/api/auth";
export const GITHUB_PROVIDER_ID = "github";
export const CLIENT_IP_HEADER = "cf-connecting-ip";

/** Better Auth requires a unique email. Ours is derived from the immutable GitHub ID, never real. */
export const syntheticEmail = (githubUserId: string) =>
  `github-${githubUserId}@users.sharerepo.invalid`;

export interface AuthDeps {
  readonly config: AuthConfig;
  readonly github: GitHubClient;
  /** Database, clock, IDs and correlation ID for the services the hooks call. */
  readonly services: ServiceContext;
  readonly logger: Logger;
}

// ShareRepo never stores a user's OAuth tokens; a CHECK constraint enforces it too.
const NO_TOKENS = { accessToken: null, refreshToken: null, idToken: null } as const;

export function createAuth(deps: AuthDeps) {
  const { config, github, services, logger } = deps;
  const signIn = createSignInRecorder(services, logger);

  return betterAuth({
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    telemetry: { enabled: false },
    // Better Auth's messages go through our redacting logger; its extra arguments (which can
    // include errors carrying SQL parameters) are dropped.
    logger: { level: "warn", log: forwardAuthLog(logger) },
    database: drizzleAdapter(services.db, { provider: "sqlite", schema }),
    user: { modelName: "authUsers" },
    session: { modelName: "authSessions" },
    verification: { modelName: "authVerifications" },
    account: {
      modelName: "authAccounts",
      // Implicit linking matches on email, which is derived from the GitHub ID: a match can only
      // be the same GitHub account. It repairs a user whose account row failed to insert.
      accountLinking: { enabled: true, trustedProviders: [] },
    },
    emailAndPassword: { enabled: false },
    rateLimit: { enabled: true, storage: "database", modelName: "authRateLimits" },
    advanced: {
      cookiePrefix: "sharerepo",
      // Cloudflare sets this header on every request and overwrites any client-supplied value.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => services.ids.next() },
    },
    databaseHooks: {
      user: {
        create: {
          // The ShareRepo user (and its audit event) exists before the auth profile row that
          // references it, with the same ID.
          before: async (user) => {
            const { userId } = await createUserForSignIn(services);
            return { data: { ...user, id: userId } };
          },
        },
      },
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
      },
      session: {
        create: { before: (session) => signIn.beforeSessionCreate(session) },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: GITHUB_PROVIDER_ID,
            clientId: github.clientId,
            clientSecret: config.github.clientSecret,
            authorizationUrl: github.endpoints.authorizeUrl,
            scopes: [],
            pkce: true,
            getToken: async ({ code, redirectURI, codeVerifier }) => {
              const { accessToken } = await github.exchangeCode({
                code,
                redirectURI,
                codeVerifier,
              });
              return { accessToken, tokenType: "bearer" };
            },
            getUserInfo: async ({ accessToken }) => {
              const user = await github.getUser(accessToken ?? "");
              return signIn.captureProfile(user);
            },
          },
        ],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Routes Better Auth's log calls through our redacting logger. Only the message is kept: its
 * extra arguments can include errors that carry SQL parameters.
 */
export function forwardAuthLog(logger: Logger) {
  return (level: "debug" | "info" | "warn" | "error", message: string): void => {
    const fields = { source: "better-auth", authMessage: message };
    if (level === "error") logger.error("auth library error", fields);
    else logger.warn("auth library warning", fields);
  };
}

/**
 * Per-request sign-in state: the GitHub profile fetched during this request's OAuth callback,
 * and the session hook that records the sign-in with it.
 */
export function createSignInRecorder(services: ServiceContext, logger: Logger) {
  let profile: ProviderProfile | undefined;
  return {
    /** Keeps the verified profile and maps it to Better Auth's user fields. */
    captureProfile(user: GitHubUser) {
      profile = {
        provider: "github",
        externalUserId: user.id,
        username: user.login,
        displayName: user.name,
        avatarUrl: user.avatarUrl,
      };
      return {
        id: user.id,
        name: user.name ?? user.login,
        email: syntheticEmail(user.id),
        emailVerified: true,
        ...(user.avatarUrl === null ? {} : { image: user.avatarUrl }),
      };
    },
    /**
     * Records the sign-in before Better Auth creates the session. Returning false refuses the
     * session: there is no profile (not a GitHub callback) or the identity is linked elsewhere.
     */
    async beforeSessionCreate(session: { userId: string }): Promise<false | undefined> {
      if (profile === undefined) return false;
      try {
        await recordSignIn(services, { userId: session.userId }, profile);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        logger.warn("sign-in refused", { reason: "identity_conflict" });
        return false;
      }
      return undefined;
    },
  };
}
