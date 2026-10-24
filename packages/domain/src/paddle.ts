/**
 * A workspace's Paddle connection (decision 0011). `unauthorized` keeps the last known commercial
 * facts until the creator reconnects; `disconnected` rows are history, and at most one row per
 * workspace is anything else.
 */
export const PaddleConnectionStatus = {
  Active: "active",
  Unauthorized: "unauthorized",
  Disconnected: "disconnected",
} as const;
export type PaddleConnectionStatus =
  (typeof PaddleConnectionStatus)[keyof typeof PaddleConnectionStatus];
/** Every Paddle connection status, in the order the database CHECK lists them. */
export const PADDLE_CONNECTION_STATUSES = [
  PaddleConnectionStatus.Active,
  PaddleConnectionStatus.Unauthorized,
  PaddleConnectionStatus.Disconnected,
] as const;

/** The Paddle environment a key belongs to, taken from its prefix (`pdl_sdbx_…`, `pdl_live_…`). */
export const PaddleEnvironment = {
  Sandbox: "sandbox",
  Live: "live",
} as const;
export type PaddleEnvironment = (typeof PaddleEnvironment)[keyof typeof PaddleEnvironment];
/** Every Paddle environment, in the order the database CHECK lists them. */
export const PADDLE_ENVIRONMENTS = [PaddleEnvironment.Sandbox, PaddleEnvironment.Live] as const;

/** How a commercial connection authenticates. v1 uses API keys; OAuth waits for Paddle's approval. */
export const CredentialKind = {
  ApiKey: "api_key",
  OAuth: "oauth",
} as const;
export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind];
/** Every credential kind, in the order the database CHECK lists them. */
export const CREDENTIAL_KINDS = [CredentialKind.ApiKey, CredentialKind.OAuth] as const;

/** A Paddle price's status as last imported. Archived prices stay in the catalog, marked. */
export const PaddlePriceStatus = {
  Active: "active",
  Archived: "archived",
} as const;
export type PaddlePriceStatus = (typeof PaddlePriceStatus)[keyof typeof PaddlePriceStatus];
/** Every Paddle price status, in the order the database CHECK lists them. */
export const PADDLE_PRICE_STATUSES = [
  PaddlePriceStatus.Active,
  PaddlePriceStatus.Archived,
] as const;

/** The unit of a recurring Paddle price's billing cycle; one-time prices have none. */
export const PaddleBillingInterval = {
  Day: "day",
  Week: "week",
  Month: "month",
  Year: "year",
} as const;
export type PaddleBillingInterval =
  (typeof PaddleBillingInterval)[keyof typeof PaddleBillingInterval];
/** Every Paddle billing interval, in the order the database CHECK lists them. */
export const PADDLE_BILLING_INTERVALS = [
  PaddleBillingInterval.Day,
  PaddleBillingInterval.Week,
  PaddleBillingInterval.Month,
  PaddleBillingInterval.Year,
] as const;
