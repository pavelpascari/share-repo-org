// Provider adapters (architecture § Integrations). v1: GitHub.
export {
  createGitHubApp,
  type GitHubAppClient,
  type GitHubAppOptions,
  REQUEST_TIMEOUT_MS,
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
  type GitHubApiErrorDetails,
  type GitHubApiErrorKind,
  type GitHubNotFoundTarget,
  InvalidWebhookError,
} from "./github/errors.ts";
export type {
  AddCollaboratorResult,
  GitHubAccount,
  GitHubAccountType,
  GitHubAppPort,
  GitHubCollaborator,
  GitHubCollaboratorAffiliation,
  GitHubInstallation,
  GitHubInvitation,
  GitHubPermission,
  GitHubRepository,
  GitHubUser,
  GitHubUserType,
} from "./github/port.ts";
export {
  parseWebhookEnvelope,
  payloadDigest,
  type RawBody,
  verifyWebhookSignature,
  type WebhookEnvelope,
} from "./github/webhooks.ts";
