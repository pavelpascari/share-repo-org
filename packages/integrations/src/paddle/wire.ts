import { PADDLE_BILLING_INTERVALS } from "@sharerepo/domain";
import { z } from "zod";
import { PaddleApiError } from "./errors.ts";
import { claimReferenceOf } from "./normalize.ts";
import {
  PADDLE_SCHEDULED_CHANGE_ACTIONS,
  PADDLE_SUBSCRIPTION_ITEM_STATUSES,
  PADDLE_SUBSCRIPTION_STATUSES,
  type PaddleApiRoot,
  type PaddleCustomer,
  type PaddleCustomerSubscription,
  type PaddleNotificationSetting,
  type PaddlePrice,
  type PaddleSubscription,
  type PaddleSubscriptionSummary,
} from "./port.ts";

// Paddle Billing API version 1 response shapes (developer.paddle.com/api-reference), reduced to
// the fields ShareRepo reads. Unknown fields are ignored. Shared by the HTTP client and the fake,
// so both map the same wire format the same way.

/** RFC 3339; Paddle sends up to microseconds (`…27.185672Z`), kept to the millisecond. */
const timestamp = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));

/** Paddle IDs: a prefix and 26 lower-case letters or digits (`sub_01hv959anj4zrw503h2acawb3p`). */
const PADDLE_ID = {
  sub: /^sub_[a-z\d]{26}$/,
  ctm: /^ctm_[a-z\d]{26}$/,
  pri: /^pri_[a-z\d]{26}$/,
  ntfset: /^ntfset_[a-z\d]{26}$/,
} as const;
export type PaddleIdKind = keyof typeof PADDLE_ID;

/** Checks a Paddle ID before it reaches a URL path or body; never echoes the value. */
export function paddleId(kind: PaddleIdKind, value: string): string {
  if (!PADDLE_ID[kind].test(value)) {
    throw new PaddleApiError("rejected", `Paddle request refused: invalid ${kind} ID`);
  }
  return value;
}

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z\\d]{26}$`));

export const apiRootSchema = z.object({
  data: z.object({
    api: z.object({ environment: z.enum(["production", "sandbox"]) }),
    caller: z.object({
      auth_type: z.string().min(1).nullable(),
      account: z.object({ id: id("slr"), name: z.string() }).nullable(),
      permissions: z.array(z.string()),
    }),
  }),
});

/** `null` when Paddle answered without a seller account (no valid credentials). */
export function toApiRoot(body: z.output<typeof apiRootSchema>): PaddleApiRoot | null {
  const { api, caller } = body.data;
  if (caller.account === null || caller.auth_type === null) return null;
  return {
    sellerId: caller.account.id,
    sellerName: caller.account.name,
    environment: api.environment === "production" ? "live" : "sandbox",
    authType: caller.auth_type,
    permissions: caller.permissions,
  };
}

const billingCycle = z.object({
  interval: z.enum(PADDLE_BILLING_INTERVALS),
  frequency: z.number().int().positive(),
});

export const priceSchema = z.object({
  id: id("pri"),
  product_id: id("pro"),
  description: z.string(),
  billing_cycle: billingCycle.nullable(),
  unit_price: z.object({ amount: z.string().regex(/^\d+$/), currency_code: z.string().min(1) }),
  status: z.enum(["active", "archived"]),
  product: z.object({
    id: id("pro"),
    name: z.string(),
    description: z.string().nullable().optional(),
  }),
});

export function toPrice(price: z.output<typeof priceSchema>): PaddlePrice {
  return {
    id: price.id,
    productId: price.product_id,
    productName: price.product.name,
    productDescription: price.product.description ?? null,
    description: price.description,
    billingCycle: price.billing_cycle,
    unitAmount: price.unit_price.amount,
    currency: price.unit_price.currency_code,
    status: price.status,
  };
}

const subscriptionStatus = z.enum(PADDLE_SUBSCRIPTION_STATUSES);

export const subscriptionSchema = z.object({
  id: id("sub"),
  customer_id: id("ctm"),
  status: subscriptionStatus,
  items: z.array(
    z.object({
      status: z.enum(PADDLE_SUBSCRIPTION_ITEM_STATUSES),
      price: z.object({ id: id("pri") }),
    }),
  ),
  current_billing_period: z.object({ starts_at: timestamp, ends_at: timestamp }).nullable(),
  scheduled_change: z
    .object({ action: z.enum(PADDLE_SCHEDULED_CHANGE_ACTIONS), effective_at: timestamp })
    .nullable(),
  canceled_at: timestamp.nullable(),
  updated_at: timestamp,
  custom_data: z.record(z.string(), z.unknown()).nullable(),
});

export function toSubscription(sub: z.output<typeof subscriptionSchema>): PaddleSubscription {
  const period = sub.current_billing_period;
  const change = sub.scheduled_change;
  return {
    id: sub.id,
    customerId: sub.customer_id,
    status: sub.status,
    items: sub.items.map((item) => ({ priceId: item.price.id, status: item.status })),
    currentBillingPeriod: period && { startsAt: period.starts_at, endsAt: period.ends_at },
    scheduledChange: change && { action: change.action, effectiveAt: change.effective_at },
    canceledAt: sub.canceled_at,
    updatedAt: sub.updated_at,
    customData: sub.custom_data,
  };
}

export const subscriptionSummarySchema = z.object({
  id: id("sub"),
  status: subscriptionStatus,
  updated_at: timestamp,
});

export function toSubscriptionSummary(
  sub: z.output<typeof subscriptionSummarySchema>,
): PaddleSubscriptionSummary {
  return { id: sub.id, status: sub.status, updatedAt: sub.updated_at };
}

/** A subscription in a customer's list: its ID and the custom data the claim rule reads. */
export const customerSubscriptionSchema = z.object({
  id: id("sub"),
  custom_data: z.record(z.string(), z.unknown()).nullable(),
});

export function toCustomerSubscription(
  sub: z.output<typeof customerSubscriptionSchema>,
): PaddleCustomerSubscription {
  return { id: sub.id, claimReference: claimReferenceOf(sub.custom_data) };
}

export const customerSchema = z.object({
  id: id("ctm"),
  email: z.string().min(1),
  created_at: timestamp,
});

export function toCustomer(customer: z.output<typeof customerSchema>): PaddleCustomer {
  return { id: customer.id, email: customer.email, createdAt: customer.created_at };
}

export const transactionSchema = z.object({
  id: id("txn"),
  checkout: z.object({ url: z.url().nullable() }).nullable(),
});

export const notificationSettingSchema = z.object({
  id: id("ntfset"),
  destination: z.string().min(1),
  active: z.boolean(),
  subscribed_events: z.array(z.object({ name: z.string().min(1) })),
});

export function toNotificationSetting(
  setting: z.output<typeof notificationSettingSchema>,
): PaddleNotificationSetting {
  return {
    id: setting.id,
    destination: setting.destination,
    active: setting.active,
    events: setting.subscribed_events.map((event) => event.name),
  };
}

/** `pdl_ntfset_…`: the destination's signing secret (research § 2). */
export const createdNotificationSettingSchema = z.object({
  id: id("ntfset"),
  endpoint_secret_key: z.string().regex(/^pdl_ntfset_[a-zA-Z\d]{26}_[a-zA-Z\d]{32}$/),
});

/** `{ data, meta }` around one entity. */
export const single = <T extends z.ZodType>(data: T) => z.object({ data });

/** A list page: `meta.pagination.next` is a full URL; `has_more` says whether to follow it. */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    meta: z.object({
      pagination: z.object({ next: z.string().nullable(), has_more: z.boolean() }),
    }),
  });

/** Paddle's error body; only the code is read. */
export const errorSchema = z.object({
  error: z.object({ code: z.string().regex(/^[a-z][a-z\d_]{0,99}$/) }),
});

/** Paddle requires custom data to have at least one key (research § 4). */
export function customDataBody(data: Readonly<Record<string, string>>): Record<string, string> {
  if (Object.keys(data).length === 0) {
    throw new PaddleApiError("rejected", "Paddle request refused: empty custom data");
  }
  return { ...data };
}

/** An email for the `email` filter: one plain address (a comma would add another). */
export function emailFilter(email: string): string {
  if (email.length > 254 || !/^[^\s,@]+@[^\s,@]+$/.test(email)) {
    throw new PaddleApiError("rejected", "Paddle request refused: invalid email");
  }
  return email;
}
