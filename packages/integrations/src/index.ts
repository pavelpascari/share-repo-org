// Provider adapters (architecture § Integrations). v1: GitHub.
export {
  type AddCollaboratorResult,
  createGitHubApp,
  type GitHubAppClient,
  type GitHubAppOptions,
  type GitHubCollaborator,
  type GitHubInvitation,
} from "./github/client.ts";
export {
  GITHUB_API_BASE_URL,
  GITHUB_WEB_BASE_URL,
  type GitHubAppConfig,
  type GitHubAppConfigOptions,
  normalizePrivateKey,
  parseGitHubAppConfig,
} from "./github/config.ts";
export {
  GITHUB_API_ERROR_KINDS,
  GitHubApiError,
  type GitHubApiErrorKind,
  InvalidWebhookError,
} from "./github/errors.ts";
export type {
  GitHubAccount,
  GitHubAccountType,
  GitHubAppPort,
  GitHubInstallation,
  GitHubRepository,
} from "./github/port.ts";
export {
  parseWebhookEnvelope,
  payloadDigest,
  type RawBody,
  verifyWebhookSignature,
  type WebhookEnvelope,
} from "./github/webhooks.ts";
