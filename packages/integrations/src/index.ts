// Provider adapters (architecture § Integrations). v1: GitHub, Paddle, and mail for claims.
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
export { type MailTransportConfig, parseMailConfig, type SendEmailBinding } from "./mail/config.ts";
export {
  createMailPort,
  MAIL_ERROR_KINDS,
  MAIL_REQUEST_TIMEOUT_MS,
  MailError,
  type MailErrorKind,
  type MailMessage,
  type MailPort,
  type MailPortOptions,
} from "./mail/port.ts";
export {
  createPaddleClient,
  PADDLE_PAGE_LIMIT,
  PADDLE_PAGE_SIZE,
  PADDLE_REQUEST_TIMEOUT_MS,
  type PaddleClientOptions,
} from "./paddle/client.ts";
export { PADDLE_API_BASE_URLS, type PaddleConfig, parsePaddleConfig } from "./paddle/config.ts";
export {
  type DestinationTag,
  destinationDescription,
  LEGACY_DESTINATION_DESCRIPTION,
  parseDestinationDescription,
} from "./paddle/destination-tag.ts";
export {
  InvalidPaddleWebhookError,
  isDestinationLimitError,
  PADDLE_API_ERROR_KINDS,
  PaddleApiError,
  type PaddleApiErrorDetails,
  type PaddleApiErrorKind,
  PaddleErrorCode,
} from "./paddle/errors.ts";
export {
  PADDLE_API_KEY_PATTERN,
  type PaddleApiKey,
  type PaddleApiKeyError,
  parsePaddleApiKey,
} from "./paddle/key.ts";
export {
  CLAIM_REFERENCE_KEY,
  CLAIM_REFERENCE_MAX_LENGTH,
  claimReferenceOf,
  type NormalizedPaddleSubscription,
  normalizePaddleSubscription,
} from "./paddle/normalize.ts";
export {
  type CreatedNotificationSetting,
  type CreateNotificationSettingInput,
  type CreateTransactionInput,
  PADDLE_SCHEDULED_CHANGE_ACTIONS,
  PADDLE_SUBSCRIPTION_ITEM_STATUSES,
  PADDLE_SUBSCRIPTION_STATUSES,
  type PaddleApiRoot,
  type PaddleBillingCycle,
  type PaddleCustomer,
  type PaddleCustomerSubscription,
  type PaddleCustomerSubscriptionList,
  type PaddleNotificationSetting,
  type PaddlePort,
  type PaddlePrice,
  type PaddleScheduledChangeAction,
  type PaddleSubscription,
  type PaddleSubscriptionItemStatus,
  type PaddleSubscriptionList,
  type PaddleSubscriptionStatus,
  type PaddleSubscriptionSummary,
  type PaddleTransaction,
  type PaddleTransactionDetails,
} from "./paddle/port.ts";
export {
  PADDLE_SIGNATURE_MAX_AGE_MS,
  PADDLE_SIGNATURE_MAX_FUTURE_MS,
  type PaddleEnvelope,
  type PaddleSignatureFailure,
  type PaddleSignatureResult,
  parsePaddleEnvelope,
  type VerifyPaddleSignatureInput,
  verifyPaddleSignature,
} from "./paddle/webhooks.ts";
