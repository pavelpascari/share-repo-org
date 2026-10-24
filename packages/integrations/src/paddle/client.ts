import type { Clock } from "@sharerepo/domain";
import type { z } from "zod";
import { PaddleApiError } from "./errors.ts";
import { PADDLE_SUBSCRIPTION_STATUSES, type PaddlePort } from "./port.ts";
import {
  apiRootSchema,
  createdNotificationSettingSchema,
  customDataBody,
  customerSchema,
  customerSubscriptionSchema,
  emailFilter,
  errorSchema,
  notificationSettingSchema,
  paddleId,
  page,
  priceSchema,
  single,
  subscriptionSchema,
  subscriptionSummarySchema,
  toApiRoot,
  toCustomer,
  toCustomerSubscription,
  toNotificationSetting,
  toPrice,
  toSubscription,
  toSubscriptionSummary,
  transactionSchema,
} from "./wire.ts";

// Paddle Billing's REST client for one seller's API key (decision 0011). Every response is
// Zod-parsed. https://developer.paddle.com/api-reference/overview

export interface PaddleClientOptions {
  /** The seller's key. Sent only to `apiBaseUrl`; never logged or put in an error. */
  readonly apiKey: string;
  /** `PaddleConfig.apiBaseUrls[environment]`, without a trailing slash. */
  readonly apiBaseUrl: string;
  readonly fetch: typeof fetch;
  /** Reads an HTTP-date `Retry-After`. */
  readonly clock: Clock;
}

/** How long one Paddle request may take before it is aborted and classified `transient`. */
export const PADDLE_REQUEST_TIMEOUT_MS = 20_000;
/** Lists follow at most this many pages (decision 0011). */
export const PADDLE_PAGE_LIMIT = 30;
/** The documented maximum for prices, customers and subscriptions (default 50). */
export const PADDLE_PAGE_SIZE = 200;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** The destination's fixed settings (decision 0011). */
const DESTINATION_SETTINGS = {
  description: "ShareRepo",
  type: "url",
  api_version: 1,
  include_sensitive_fields: false,
  traffic_source: "platform",
} as const;

export function createPaddleClient(options: PaddleClientOptions): PaddlePort {
  const { apiBaseUrl, clock } = options;

  async function request(
    operation: string,
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${options.apiKey}`,
      "paddle-version": "1",
      "user-agent": "ShareRepo",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await options.fetch(
        pathOrUrl.startsWith("/") ? `${apiBaseUrl}${pathOrUrl}` : pathOrUrl,
        {
          method,
          headers,
          signal: AbortSignal.timeout(PADDLE_REQUEST_TIMEOUT_MS),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      // A network failure, or the timeout aborting the request.
      throw new PaddleApiError("transient", `Paddle ${operation} failed: network error`);
    }
    if (response.ok) return response;
    throw await classify(operation, response, clock);
  }

  async function read<T extends z.ZodType>(
    operation: string,
    schema: T,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<z.output<T>> {
    const response = await request(operation, method, path, body);
    return parse(operation, schema, await json(response));
  }

  /**
   * Follows `meta.pagination.next` while `has_more`. Past the page cap, `truncate` returns what
   * was read; otherwise the list is `malformed`, never silently cut short.
   */
  async function paginate<T extends z.ZodType>(
    operation: string,
    first: string,
    item: T,
    truncate = false,
  ): Promise<{ items: z.output<T>[]; truncated: boolean }> {
    const schema = page(item);
    const items: z.output<T>[] = [];
    let next = first;
    for (let count = 1; ; count += 1) {
      const body = await read(operation, schema, "GET", next);
      items.push(...body.data);
      const { has_more: hasMore, next: link } = body.meta.pagination;
      if (!hasMore) return { items, truncated: false };
      if (count === PADDLE_PAGE_LIMIT) {
        if (truncate) return { items, truncated: true };
        throw new PaddleApiError("malformed", `Paddle ${operation}: too many pages`);
      }
      next = nextPage(link, apiBaseUrl);
    }
  }

  return {
    async getApiRoot() {
      const operation = "get API root";
      const root = toApiRoot(await read(operation, apiRootSchema, "GET", "/"));
      // Paddle documents a 403 for an invalid key; a 200 without an account means the same.
      if (root === null) {
        throw new PaddleApiError("unauthorized", `Paddle ${operation}: no seller account`);
      }
      return root;
    },

    async listPrices() {
      const { items } = await paginate(
        "list prices",
        `/prices?include=product&status=active,archived&per_page=${PADDLE_PAGE_SIZE}`,
        priceSchema,
      );
      return items.map(toPrice);
    },

    async getSubscription(subscriptionId) {
      const path = `/subscriptions/${paddleId("sub", subscriptionId)}`;
      const body = await read("get subscription", single(subscriptionSchema), "GET", path);
      return toSubscription(body.data);
    },

    async listSubscriptions() {
      const { items, truncated } = await paginate(
        "list subscriptions",
        `/subscriptions?per_page=${PADDLE_PAGE_SIZE}`,
        subscriptionSummarySchema,
        true,
      );
      return { subscriptions: items.map(toSubscriptionSummary), truncated };
    },

    async listCustomerSubscriptions(customerId) {
      // Every status, explicitly: the purchase rule (decision 0012) must see canceled and paused
      // subscriptions too, whatever Paddle's default scope for the list is or becomes.
      const query = new URLSearchParams({
        customer_id: paddleId("ctm", customerId),
        status: [...PADDLE_SUBSCRIPTION_STATUSES].sort().join(","),
        per_page: String(PADDLE_PAGE_SIZE),
      });
      const { items, truncated } = await paginate(
        "list customer subscriptions",
        `/subscriptions?${query}`,
        customerSubscriptionSchema,
        true,
      );
      return { subscriptions: items.map(toCustomerSubscription), truncated };
    },

    async listCustomersByEmail(email) {
      const query = new URLSearchParams({
        email: emailFilter(email),
        per_page: String(PADDLE_PAGE_SIZE),
      });
      const { items } = await paginate("list customers", `/customers?${query}`, customerSchema);
      return items.map(toCustomer);
    },

    async getCustomer(customerId) {
      const path = `/customers/${paddleId("ctm", customerId)}`;
      const body = await read("get customer", single(customerSchema), "GET", path);
      return toCustomer(body.data);
    },

    async createTransaction({ priceId, customData }) {
      const body = await read(
        "create transaction",
        single(transactionSchema),
        "POST",
        "/transactions",
        {
          items: [{ price_id: paddleId("pri", priceId), quantity: 1 }],
          custom_data: customDataBody(customData),
        },
      );
      return { id: body.data.id, checkoutUrl: body.data.checkout?.url ?? null };
    },

    async createNotificationSetting({ destination, events }) {
      const body = await read(
        "create notification setting",
        single(createdNotificationSettingSchema),
        "POST",
        "/notification-settings",
        { ...DESTINATION_SETTINGS, destination, subscribed_events: events },
      );
      return { id: body.data.id, secret: body.data.endpoint_secret_key };
    },

    async getNotificationSetting(settingId) {
      const path = `/notification-settings/${paddleId("ntfset", settingId)}`;
      const body = await read(
        "get notification setting",
        single(notificationSettingSchema),
        "GET",
        path,
      );
      return toNotificationSetting(body.data);
    },

    async deleteNotificationSetting(settingId) {
      const path = `/notification-settings/${paddleId("ntfset", settingId)}`;
      try {
        await request("delete notification setting", "DELETE", path);
        return "deleted";
      } catch (error) {
        if (error instanceof PaddleApiError && error.kind === "not_found") return "not_found";
        throw error;
      }
    },
  };
}

function parse<T extends z.ZodType>(operation: string, schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new PaddleApiError("malformed", `Paddle ${operation} response is malformed`);
  }
  return result.data;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * The next page's URL. It must stay under the API base URL: the request carries the seller's
 * key, which must never be sent elsewhere. Anything else is `malformed`.
 */
export function nextPage(next: string | null, apiBaseUrl: string): string {
  if (next === null || !next.startsWith(`${apiBaseUrl}/`)) {
    throw new PaddleApiError("malformed", "Paddle pagination link points outside the API");
  }
  return next;
}

async function classify(operation: string, response: Response, clock: Clock) {
  const { status } = response;
  const message = `Paddle ${operation} failed with status ${status}`;
  const parsed = errorSchema.safeParse(await json(response));
  const details = parsed.success ? { status, paddleCode: parsed.data.error.code } : { status };
  if (status === 401 || status === 403) return new PaddleApiError("unauthorized", message, details);
  if (status === 404) return new PaddleApiError("not_found", message, details);
  if (status === 429) {
    const retryAfterMs = retryAfter(response.headers.get("retry-after"), clock);
    return new PaddleApiError("rate_limited", message, { ...details, retryAfterMs });
  }
  if (status >= 500) return new PaddleApiError("transient", message, details);
  return new PaddleApiError("rejected", message, details);
}

/** `Retry-After` in seconds or as an HTTP date; Paddle's documented block is 60 s otherwise. */
export function retryAfter(header: string | null, clock: Clock): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - clock.now());
}
