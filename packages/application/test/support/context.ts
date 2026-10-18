import { env } from "cloudflare:workers";
import { createDb } from "@sharerepo/db";
import { type GitHubLogin, type GitHubUserId, parseGitHubLogin } from "@sharerepo/domain";
import { FakeClock, SequentialIds } from "@sharerepo/testing";
import {
  createUserForSignIn,
  type ProviderProfile,
  recordSignIn,
  type ServiceContext,
  type UserActor,
} from "../../src/index.ts";

// D1 is shared by every test in a file, so IDs, slugs and GitHub IDs are unique per call.
const unique = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

export const db = createDb(env.DB);
export const clock = new FakeClock();

export function serviceContext(correlationId = `corr-${unique()}`): ServiceContext {
  return { db, clock, ids: new SequentialIds({ prefix: `${unique()}-` }), correlationId };
}

let githubIds = Math.floor(Math.random() * 1e9);
export const nextGitHubUserId = () => String(++githubIds) as GitHubUserId;

export function login(value: string): GitHubLogin {
  const parsed = parseGitHubLogin(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export function githubProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    provider: "github",
    externalUserId: nextGitHubUserId(),
    username: login(`user-${unique()}`),
    displayName: "Mona Lisa",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
    ...overrides,
  };
}

/** A signed-up user with a linked GitHub identity, as after a first sign-in. */
export async function signedUpUser(
  profile = githubProfile(),
): Promise<UserActor & { profile: ProviderProfile }> {
  const { userId } = await createUserForSignIn(serviceContext());
  await recordSignIn(serviceContext(), { userId }, profile);
  return { userId, profile };
}

export const uniqueSlug = () => `ws-${unique()}`;
