/**
 * How a Paddle API failure should be handled (decision 0011). Messages carry the operation and
 * status only: never keys, secrets, emails, custom data or Paddle's `detail`, which may echo
 * input. `paddleCode` is Paddle's documented `error.code` (a slug such as `forbidden`).
 *
 * | kind           | cause                                                                  |
 * |----------------|------------------------------------------------------------------------|
 * | `unauthorized` | 401 or 403: the key is invalid, expired, revoked or lacks a permission |
 * | `not_found`    | 404                                                                    |
 * | `rate_limited` | 429 (`too_many_requests`); `retryAfterMs` from `Retry-After`           |
 * | `transient`    | 5xx, a network failure, or a request aborted by its timeout            |
 * | `rejected`     | any other 4xx, or input refused before any request                     |
 * | `malformed`    | a 2xx body that does not match the expected shape, or too many pages   |
 */
export const PADDLE_API_ERROR_KINDS = [
  "unauthorized",
  "not_found",
  "rate_limited",
  "transient",
  "rejected",
  "malformed",
] as const;
export type PaddleApiErrorKind = (typeof PADDLE_API_ERROR_KINDS)[number];

/**
 * Paddle error codes callers act on. Both are documented (developer.paddle.com/errors) as 400
 * `request_error`.
 */
export const PaddleErrorCode = {
  /** "Your account has reached the maximum of 10 active notification settings." */
  DestinationLimitReached: "notification_maximum_active_settings_reached",
  /** The seller has no default payment link, so no transaction or checkout can be created. */
  DefaultPaymentLinkNotSet: "transaction_default_checkout_url_not_set",
} as const;
export type PaddleErrorCode = (typeof PaddleErrorCode)[keyof typeof PaddleErrorCode];

export interface PaddleApiErrorDetails {
  readonly status?: number;
  /** For `rate_limited`: how long to wait before retrying. */
  readonly retryAfterMs?: number;
  /** Paddle's `error.code`, when the body carried a well-formed one. */
  readonly paddleCode?: string;
}

export class PaddleApiError extends Error {
  readonly kind: PaddleApiErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly paddleCode: string | undefined;

  constructor(kind: PaddleApiErrorKind, message: string, details: PaddleApiErrorDetails = {}) {
    super(message);
    this.name = "PaddleApiError";
    this.kind = kind;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.paddleCode = details.paddleCode;
  }
}

/** Whether Paddle refused a new destination because 10 are already active. */
export function isDestinationLimitError(error: unknown): boolean {
  return (
    error instanceof PaddleApiError && error.paddleCode === PaddleErrorCode.DestinationLimitReached
  );
}

/** A webhook body that does not have Paddle's envelope shape. */
export class InvalidPaddleWebhookError extends Error {
  constructor() {
    super("Paddle webhook envelope is invalid");
    this.name = "InvalidPaddleWebhookError";
  }
}
