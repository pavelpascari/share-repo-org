import type {
  Instant,
  PaddleBillingInterval,
  PaddleEnvironment,
  PaddlePriceStatus,
} from "@sharerepo/domain";

/** `GET /`: who the key belongs to and what it may do (decision 0011). */
export interface PaddleApiRoot {
  /** `slr_…`. */
  readonly sellerId: string;
  readonly sellerName: string;
  /** Paddle's `production` is `live`. */
  readonly environment: PaddleEnvironment;
  /** `api_key`, `oauth`, `client_token` or `session`; kept as Paddle reports it. */
  readonly authType: string;
  /** Permission names such as `subscription.read`. */
  readonly permissions: readonly string[];
}

export interface PaddleBillingCycle {
  readonly interval: PaddleBillingInterval;
  readonly frequency: number;
}

/** A price with its product (`GET /prices?include=product`). */
export interface PaddlePrice {
  /** `pri_…`. */
  readonly id: string;
  /** `pro_…`. */
  readonly productId: string;
  readonly productName: string;
  readonly productDescription: string | null;
  /** The price's own description, shown to the creator. */
  readonly description: string;
  /** `null` for a one-time price. */
  readonly billingCycle: PaddleBillingCycle | null;
  /** Minor units, as Paddle's decimal string (`"3000"`). */
  readonly unitAmount: string;
  /** ISO 4217, as Paddle reports it (`USD`). */
  readonly currency: string;
  readonly status: PaddlePriceStatus;
}

export const PADDLE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
] as const;
export type PaddleSubscriptionStatus = (typeof PADDLE_SUBSCRIPTION_STATUSES)[number];

export const PADDLE_SUBSCRIPTION_ITEM_STATUSES = ["active", "inactive", "trialing"] as const;
export type PaddleSubscriptionItemStatus = (typeof PADDLE_SUBSCRIPTION_ITEM_STATUSES)[number];

export const PADDLE_SCHEDULED_CHANGE_ACTIONS = ["cancel", "pause", "resume"] as const;
export type PaddleScheduledChangeAction = (typeof PADDLE_SCHEDULED_CHANGE_ACTIONS)[number];

/**
 * The subscription fields ShareRepo reads (`GET /subscriptions/{id}`), times as UTC instants.
 * Commercial facts only; `normalizePaddleSubscription` turns them into a snapshot.
 */
export interface PaddleSubscription {
  /** `sub_…`. */
  readonly id: string;
  /** `ctm_…`. */
  readonly customerId: string;
  readonly status: PaddleSubscriptionStatus;
  readonly items: readonly {
    readonly priceId: string;
    readonly status: PaddleSubscriptionItemStatus;
  }[];
  /** `null` while paused or canceled. */
  readonly currentBillingPeriod: { readonly startsAt: Instant; readonly endsAt: Instant } | null;
  readonly scheduledChange: {
    readonly action: PaddleScheduledChangeAction;
    readonly effectiveAt: Instant;
  } | null;
  readonly canceledAt: Instant | null;
  readonly updatedAt: Instant;
  /** Untrusted: the buyer's browser can rewrite it (threat model T11). */
  readonly customData: Readonly<Record<string, unknown>> | null;
}

/** One row of the daily sweep (`GET /subscriptions`). */
export interface PaddleSubscriptionSummary {
  readonly id: string;
  readonly status: PaddleSubscriptionStatus;
  readonly updatedAt: Instant;
}

export interface PaddleSubscriptionList {
  readonly subscriptions: readonly PaddleSubscriptionSummary[];
  /**
   * The list stopped at the page cap (30 pages of 200) with more to come. The sweep only enqueues
   * refreshes, so a partial list is still useful; newest first (Paddle's default `id[DESC]`).
   */
  readonly truncated: boolean;
}

/** One of a customer's subscriptions, with the claim reference it carries. */
export interface PaddleCustomerSubscription {
  /** `sub_…`. */
  readonly id: string;
  /** `ctm_…`, as Paddle reports it; the caller checks it is the customer it asked about. */
  readonly customerId: string;
  /** `custom_data.sharerepo_claim`, extracted as `normalizePaddleSubscription` does. Untrusted. */
  readonly claimReference: string | null;
}

export interface PaddleCustomerSubscriptionList {
  readonly subscriptions: readonly PaddleCustomerSubscription[];
  /** The list stopped at the page cap (30 pages of 200) with more to come. */
  readonly truncated: boolean;
}

/** A customer's ID and the email Paddle holds. The email is for the caller only: never log it. */
export interface PaddleCustomer {
  /** `ctm_…`. */
  readonly id: string;
  readonly email: string;
  /**
   * When Paddle created the customer. A checkout reuses an existing customer with the email the
   * buyer enters, so this tells whether a checkout created the customer (decision 0012, path 1).
   */
  readonly createdAt: Instant;
}

export interface CreateTransactionInput {
  /** `pri_…`; quantity is always 1. */
  readonly priceId: string;
  /** Copied by Paddle to the subscription the checkout creates (research § 4). */
  readonly customData: Readonly<Record<string, string>>;
}

export interface PaddleTransaction {
  /** `txn_…`. */
  readonly id: string;
  /** The seller's default payment link with `?_ptxn=`; `null` if Paddle returned none. */
  readonly checkoutUrl: string | null;
}

export interface CreateNotificationSettingInput {
  /** The HTTPS URL Paddle delivers to. */
  readonly destination: string;
  /** Event type names, such as `subscription.created`. */
  readonly events: readonly string[];
}

/** A created destination. `secret` is the `endpoint_secret_key`: seal it, never log it. */
export interface CreatedNotificationSetting {
  /** `ntfset_…`. */
  readonly id: string;
  readonly secret: string;
}

/** A destination as read back. The secret is deliberately not returned. */
export interface PaddleNotificationSetting {
  readonly id: string;
  readonly destination: string;
  readonly active: boolean;
  readonly events: readonly string[];
}

/**
 * What application services need from one seller's Paddle account, through one API key. The fake
 * implements the same port. Failures are `PaddleApiError`s (see its classification table). IDs
 * placed in a URL path are validated first (`rejected`, never echoed).
 */
export interface PaddlePort {
  /** `GET /`. Needs no permission; an invalid key is `unauthorized`. */
  getApiRoot(): Promise<PaddleApiRoot>;
  /** Active and archived prices with their products, every page (200 each, at most 30). */
  listPrices(): Promise<PaddlePrice[]>;
  /** `not_found` for an unknown subscription. */
  getSubscription(subscriptionId: string): Promise<PaddleSubscription>;
  /** Every subscription, any status, newest first, up to the page cap. */
  listSubscriptions(): Promise<PaddleSubscriptionList>;
  /**
   * Every subscription of one customer, any status, newest first, up to the page cap
   * (`GET /subscriptions?customer_id=&status=<every status>`). An unknown customer has none.
   */
  listCustomerSubscriptions(customerId: string): Promise<PaddleCustomerSubscriptionList>;
  /** Active customers whose email matches exactly (Paddle's `email` filter). */
  listCustomersByEmail(email: string): Promise<PaddleCustomer[]>;
  /** `not_found` for an unknown customer. */
  getCustomer(customerId: string): Promise<PaddleCustomer>;
  /** A draft transaction for one price, to open a checkout. */
  createTransaction(input: CreateTransactionInput): Promise<PaddleTransaction>;
  /**
   * A URL destination, pinned to API version 1, platform traffic, no sensitive fields. A seller
   * with 10 active destinations is `rejected` with `PaddleErrorCode.DestinationLimitReached`.
   */
  createNotificationSetting(
    input: CreateNotificationSettingInput,
  ): Promise<CreatedNotificationSetting>;
  /** `not_found` once deleted. */
  getNotificationSetting(settingId: string): Promise<PaddleNotificationSetting>;
  /** `not_found`: already gone. */
  deleteNotificationSetting(settingId: string): Promise<"deleted" | "not_found">;
}
