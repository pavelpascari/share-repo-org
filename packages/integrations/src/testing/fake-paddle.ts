import {
  type Clock,
  type Instant,
  type PaddleEnvironment,
  type PaddlePriceStatus,
  systemClock,
} from "@sharerepo/domain";
import {
  PaddleApiError,
  type PaddleApiErrorDetails,
  type PaddleApiErrorKind,
  PaddleErrorCode,
} from "../paddle/errors.ts";
import type {
  PaddleBillingCycle,
  PaddleCustomer,
  PaddleNotificationSetting,
  PaddlePort,
  PaddlePrice,
  PaddleSubscription,
} from "../paddle/port.ts";
import {
  customDataBody,
  customerSubscriptionSchema,
  emailFilter,
  paddleId,
  subscriptionSchema,
  toCustomerSubscription,
  toSubscription,
} from "../paddle/wire.ts";
import { signPaddleWebhook } from "./sign-paddle-webhook.ts";

/**
 * In-memory stand-in for one seller's Paddle account behind one API key, for application, jobs
 * and web tests. It keeps subscriptions in Paddle's wire format and reads them through the HTTP
 * client's own schemas, so both map identically; the shared contract suite checks the rest.
 *
 * Behaviour callers depend on:
 * - a revoked key, or a missing permission, is `unauthorized` (403 `forbidden`);
 * - unknown entities are `not_found`; IDs are validated as the client does (`rejected`);
 * - no default payment link: `createTransaction` is `rejected` with
 *   `transaction_default_checkout_url_not_set`;
 * - a new destination beyond 10 active ones is `rejected` with
 *   `notification_maximum_active_settings_reached`; a duplicate URL with
 *   `notification_setting_cannot_be_duplicate`;
 * - customers match the `email` filter exactly, case included (Paddle: "exactly match");
 * - every change bumps `updated_at`, strictly increasing even when the clock stands still.
 */
export const FAKE_PADDLE_PERMISSIONS = [
  "product.read",
  "price.read",
  "customer.read",
  "subscription.read",
  "transaction.read",
  "transaction.write",
  "notification_setting.write",
] as const;

/** The permission each port operation needs (`write` includes `read`). */
const REQUIRED_PERMISSION: Record<FakePaddleOperation, string | null> = {
  getApiRoot: null,
  listPrices: "price.read",
  getSubscription: "subscription.read",
  listSubscriptions: "subscription.read",
  listCustomerSubscriptions: "subscription.read",
  listCustomersByEmail: "customer.read",
  getCustomer: "customer.read",
  createTransaction: "transaction.write",
  createNotificationSetting: "notification_setting.write",
  getNotificationSetting: "notification_setting.read",
  listNotificationSettings: "notification_setting.read",
  deleteNotificationSetting: "notification_setting.write",
};

export type FakePaddleOperation = keyof PaddlePort;
/** Operations that change state, so their response can be lost after the change. */
export type FakePaddleMutation =
  | "createTransaction"
  | "createNotificationSetting"
  | "deleteNotificationSetting";

export interface FakePaddleOptions {
  readonly clock?: Clock;
  readonly seller?: { readonly id: string; readonly name: string };
  readonly environment?: PaddleEnvironment;
  readonly permissions?: readonly string[];
  /** The seller's default payment link; `null` for none. */
  readonly defaultPaymentLink?: string | null;
  /**
   * Up to 16 lower-case letters or digits at the start of every generated ID, so several fakes
   * (one per seller, as in the E2E server) never generate the same ID.
   */
  readonly idSeed?: string;
}

export interface FakePriceInput {
  readonly id?: string;
  readonly productId?: string;
  readonly productName?: string;
  readonly productDescription?: string | null;
  readonly description?: string;
  /** Defaults to monthly; `null` for a one-time price. */
  readonly billingCycle?: PaddleBillingCycle | null;
  readonly unitAmount?: string;
  readonly currency?: string;
  readonly status?: PaddlePriceStatus;
}

export interface FakeSubscriptionInput {
  readonly id?: string;
  readonly customerId: string;
  readonly priceIds: readonly string[];
  readonly customData?: Record<string, unknown> | null;
  /** `trialing` starts a 14-day trial period. */
  readonly status?: "active" | "trialing";
}

/** Who pays at checkout: an existing customer, or whoever enters this email. */
export type FakeCheckoutBuyer = { readonly customerId: string } | { readonly email: string };

export interface FakeTransaction {
  readonly id: string;
  readonly priceId: string;
  readonly customData: Readonly<Record<string, string>>;
  readonly checkoutUrl: string;
  readonly subscriptionId: string | null;
}

/** A signed webhook delivery, as Paddle would POST it to the destination. */
export interface FakePaddleDelivery {
  readonly destination: string;
  readonly settingId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly notificationId: string;
  readonly rawBody: string;
  /** The `Paddle-Signature` header. */
  readonly signature: string;
}

export interface FakeEventInput {
  readonly settingId: string;
  readonly eventType: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** Defaults to now. */
  readonly occurredAt?: Instant;
  /** When the delivery is signed; defaults to now. */
  readonly signedAt?: Instant;
}

export interface FakePaddle extends PaddlePort {
  /** Every port call, by operation name, including failed ones. */
  readonly calls: readonly string[];

  addPrice(input?: FakePriceInput): PaddlePrice;
  archivePrice(priceId: string): void;
  /** A customer Paddle created at `createdAt` (default: now). */
  addCustomer(input: {
    readonly id?: string;
    readonly email: string;
    readonly createdAt?: Instant;
  }): PaddleCustomer;
  setCustomerEmail(customerId: string, email: string): void;
  setDefaultPaymentLink(url: string | null): void;
  /** A transaction created through the port. */
  transaction(transactionId: string): FakeTransaction;

  // Subscription lifecycle. Each returns the subscription as the port reads it.

  /**
   * The buyer pays: the subscription is created from the transaction, its custom data copied. The
   * buyer is an existing customer (`customerId`), or enters an `email` at checkout: as Paddle
   * does, an existing customer with exactly that email is reused, else one is created now.
   */
  completeCheckout(
    transactionId: string,
    input: FakeCheckoutBuyer & { readonly subscriptionId?: string },
  ): PaddleSubscription;
  /** A subscription created outside a ShareRepo checkout (for example a shared Paddle link). */
  createSubscription(input: FakeSubscriptionInput): PaddleSubscription;
  /** Trial ends or a past-due payment succeeds: `active`, with a period starting now. */
  activate(subscriptionId: string): PaddleSubscription;
  /** A renewal payment failed. */
  markPastDue(subscriptionId: string): PaddleSubscription;
  /** Cancels at `effectiveAt`, by default the end of the current period. */
  scheduleCancel(subscriptionId: string, effectiveAt?: Instant): PaddleSubscription;
  /** Pauses at `effectiveAt`, by default the end of the current period. */
  schedulePause(subscriptionId: string, effectiveAt?: Instant): PaddleSubscription;
  removeScheduledChange(subscriptionId: string): PaddleSubscription;
  /** `canceled` now, as when a scheduled cancellation takes effect. */
  cancelNow(subscriptionId: string): PaddleSubscription;
  pause(subscriptionId: string): PaddleSubscription;
  /** Paddle bills immediately on resume: `active`, with a period starting now. */
  resume(subscriptionId: string): PaddleSubscription;
  /** A successful renewal: the next period, `active`. */
  renew(subscriptionId: string): PaddleSubscription;
  updateCustomData(
    subscriptionId: string,
    data: Record<string, unknown> | null,
  ): PaddleSubscription;
  subscription(subscriptionId: string): PaddleSubscription;

  // Notifications.

  /** Every destination created through the port (ShareRepo's), active or not. */
  notificationSettings(): PaddleNotificationSetting[];
  /**
   * Other apps' active destinations, which count towards the limit of 10 and are listed by
   * `listNotificationSettings`, with their own descriptions and URLs.
   */
  addForeignDestinations(count: number): void;
  deactivateNotificationSetting(settingId: string): void;
  /** The destination's secret, as Paddle holds it. */
  secretOf(settingId: string): string;
  /** A signed delivery of any event to one of ShareRepo's destinations. */
  emit(input: FakeEventInput): Promise<FakePaddleDelivery>;
  /**
   * One event delivered to every active destination, as Paddle does: one notification per
   * destination, sharing the event ID, each signed with its destination's secret (two during a
   * webhook secret rotation).
   */
  emitToAll(input: Omit<FakeEventInput, "settingId">): Promise<FakePaddleDelivery[]>;
  /** A `subscription.*` event carrying the subscription as it is now. */
  emitSubscriptionEvent(
    settingId: string,
    eventType: string,
    subscriptionId: string,
  ): Promise<FakePaddleDelivery>;
  /** A `transaction.*` event for a transaction created through the port. */
  emitTransactionEvent(
    settingId: string,
    eventType: string,
    transactionId: string,
  ): Promise<FakePaddleDelivery>;
  /** Paddle's replay: a new notification ID for the same event, signed now. */
  replay(delivery: FakePaddleDelivery): Promise<FakePaddleDelivery>;

  // The key and faults.

  /** The key stops working: every call is `unauthorized` until `restoreKey`. */
  revokeKey(): void;
  restoreKey(): void;
  setPermissions(permissions: readonly string[]): void;
  /** The next call of `operation` fails with this kind, without doing anything. */
  failNext(
    operation: FakePaddleOperation,
    kind: PaddleApiErrorKind,
    details?: PaddleApiErrorDetails,
  ): void;
  /** The next call of `operation` does its work, then throws `transient` (a lost response). */
  loseNextResponse(operation: FakePaddleMutation): void;
  /**
   * The next call of `operation` hangs past the client's timeout (`PADDLE_REQUEST_TIMEOUT_MS`):
   * it does nothing and fails as the real client fails a request its timeout aborted,
   * `transient` with no status. A hang after Paddle applied a change is `loseNextResponse`.
   */
  hangNext(operation: FakePaddleOperation): void;
  /** Paddle is down: every call fails `transient` with status 503 until the clock reaches `until`. */
  outage(until: Instant): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_MS = 14 * DAY_MS;
const DESTINATION_LIMIT = 10;
const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

type WireSubscription = {
  id: string;
  status: PaddleSubscription["status"];
  customer_id: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  first_billed_at: string | null;
  next_billed_at: string | null;
  paused_at: string | null;
  canceled_at: string | null;
  collection_mode: "automatic";
  currency_code: string;
  billing_cycle: PaddleBillingCycle;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: {
    action: "cancel" | "pause" | "resume";
    effective_at: string;
    resume_at: null;
  } | null;
  items: {
    status: "active" | "inactive" | "trialing";
    quantity: 1;
    recurring: true;
    price: { id: string; product_id: string };
  }[];
  custom_data: Record<string, unknown> | null;
};

interface Setting {
  setting: PaddleNotificationSetting;
  secret: string;
  /** Another app's destination (`addForeignDestinations`). */
  foreign?: true;
}

const iso = (at: Instant) => new Date(at).toISOString();

function randomText(length: number): string {
  const values = crypto.getRandomValues(new Uint8Array(length));
  return [...values].map((value) => ALPHANUMERIC[value % ALPHANUMERIC.length]).join("");
}

/** `start` plus `frequency` intervals, in UTC calendar terms. */
export function addBillingCycle(start: Instant, cycle: PaddleBillingCycle): Instant {
  const date = new Date(start);
  const { interval, frequency } = cycle;
  if (interval === "day") date.setUTCDate(date.getUTCDate() + frequency);
  else if (interval === "week") date.setUTCDate(date.getUTCDate() + 7 * frequency);
  else if (interval === "month") date.setUTCMonth(date.getUTCMonth() + frequency);
  else date.setUTCFullYear(date.getUTCFullYear() + frequency);
  return date.getTime();
}

export function createFakePaddle(options: FakePaddleOptions = {}): FakePaddle {
  const clock = options.clock ?? systemClock;
  const seller = options.seller ?? { id: `slr_${"0".repeat(25)}1`, name: "Fake Seller" };
  const environment = options.environment ?? "sandbox";
  let permissions = [...(options.permissions ?? FAKE_PADDLE_PERMISSIONS)];
  let defaultPaymentLink =
    options.defaultPaymentLink === undefined
      ? "https://seller.example/pay"
      : options.defaultPaymentLink;
  let revoked = false;
  const calls: string[] = [];
  const failures = new Map<FakePaddleOperation, PaddleApiError>();
  const lostResponses = new Set<FakePaddleOperation>();
  const hangs = new Set<FakePaddleOperation>();
  let outageUntil: Instant | null = null;
  const prices = new Map<string, PaddlePrice>();
  const customers = new Map<string, PaddleCustomer>();
  const subscriptions = new Map<string, WireSubscription>();
  const transactions = new Map<string, FakeTransaction>();
  const settings = new Map<string, Setting>();
  const counters = new Map<string, number>();
  const idSeed = options.idSeed ?? "";
  if (!/^[a-z\d]{0,16}$/.test(idSeed)) throw new Error("fake: idSeed must be [a-z0-9]{0,16}");

  function nextId(prefix: string): string {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${idSeed}${String(next).padStart(26 - idSeed.length, "0")}`;
  }

  function begin(operation: FakePaddleOperation): void {
    calls.push(operation);
    if (outageUntil !== null && clock.now() < outageUntil) {
      throw new PaddleApiError("transient", `Paddle ${operation} failed with status 503`, {
        status: 503,
      });
    }
    if (hangs.delete(operation)) {
      throw new PaddleApiError("transient", `Paddle ${operation} failed: network error`);
    }
    const injected = failures.get(operation);
    if (injected !== undefined) {
      failures.delete(operation);
      throw injected;
    }
    const needed = REQUIRED_PERMISSION[operation];
    const allowed =
      needed === null ||
      permissions.includes(needed) ||
      permissions.includes(needed.replace(/\.read$/, ".write"));
    if (revoked || !allowed) {
      throw new PaddleApiError("unauthorized", `Paddle ${operation} failed with status 403`, {
        status: 403,
        paddleCode: "forbidden",
      });
    }
  }

  function settle<T>(operation: FakePaddleOperation, result: T): T {
    if (lostResponses.delete(operation)) {
      throw new PaddleApiError("transient", `Paddle ${operation} failed: network error`);
    }
    return result;
  }

  const notFound = (operation: string) =>
    new PaddleApiError("not_found", `Paddle ${operation} failed with status 404`, {
      status: 404,
      paddleCode: "not_found",
    });
  const rejected = (operation: string, paddleCode: string) =>
    new PaddleApiError("rejected", `Paddle ${operation} failed with status 400`, {
      status: 400,
      paddleCode,
    });

  /** Reads a wire subscription exactly as the HTTP client would. */
  const read = (wire: WireSubscription) =>
    toSubscription(subscriptionSchema.parse(structuredClone(wire)));

  function wire(subscriptionId: string): WireSubscription {
    const found = subscriptions.get(subscriptionId);
    if (found === undefined) throw new Error(`fake: unknown subscription ${subscriptionId}`);
    return found;
  }

  /**
   * Applies a change at the clock's time, and bumps `updated_at` past the previous value so every
   * change is strictly newer, even when the clock stands still.
   */
  function change(subscriptionId: string, apply: (sub: WireSubscription, now: Instant) => void) {
    const sub = wire(subscriptionId);
    const now = clock.now();
    apply(sub, now);
    sub.updated_at = iso(Math.max(now, Date.parse(sub.updated_at) + 1));
    return read(sub);
  }

  function startPeriod(sub: WireSubscription, from: Instant): void {
    const ends = addBillingCycle(from, sub.billing_cycle);
    sub.current_billing_period = { starts_at: iso(from), ends_at: iso(ends) };
    sub.next_billed_at = iso(ends);
  }

  function setItemStatus(sub: WireSubscription, status: "active" | "trialing"): void {
    for (const item of sub.items) item.status = status;
  }

  function periodEnd(sub: WireSubscription, given: Instant | undefined): Instant {
    if (given !== undefined) return given;
    if (sub.current_billing_period === null) {
      throw new Error(`fake: ${sub.id} has no current period to schedule against`);
    }
    return Date.parse(sub.current_billing_period.ends_at);
  }

  function create(input: FakeSubscriptionInput): PaddleSubscription {
    const id = input.id ?? nextId("sub");
    if (subscriptions.has(id)) throw new Error(`fake: subscription ${id} exists`);
    if (!customers.has(input.customerId))
      throw new Error(`fake: unknown customer ${input.customerId}`);
    const items = input.priceIds.map((priceId) => {
      const price = prices.get(priceId);
      if (price === undefined || price.billingCycle === null)
        throw new Error(`fake: ${priceId} is not a recurring price`);
      return price;
    });
    const [first] = items;
    if (first === undefined) throw new Error("fake: a subscription needs a price");
    const now = clock.now();
    const trialing = input.status === "trialing";
    const sub: WireSubscription = {
      id,
      status: trialing ? "trialing" : "active",
      customer_id: input.customerId,
      created_at: iso(now),
      updated_at: iso(now),
      started_at: iso(now),
      first_billed_at: trialing ? null : iso(now),
      next_billed_at: null,
      paused_at: null,
      canceled_at: null,
      collection_mode: "automatic",
      currency_code: first.currency,
      billing_cycle: first.billingCycle as PaddleBillingCycle,
      current_billing_period: null,
      scheduled_change: null,
      items: items.map((price) => ({
        status: trialing ? "trialing" : "active",
        quantity: 1,
        recurring: true,
        price: { id: price.id, product_id: price.productId },
      })),
      custom_data: input.customData === undefined ? null : structuredClone(input.customData),
    };
    if (trialing) {
      sub.current_billing_period = { starts_at: iso(now), ends_at: iso(now + TRIAL_MS) };
      sub.next_billed_at = iso(now + TRIAL_MS);
    } else {
      startPeriod(sub, now);
    }
    subscriptions.set(id, sub);
    return read(sub);
  }

  function existingSetting(settingId: string): Setting {
    const found = settings.get(settingId);
    if (found === undefined) throw new Error(`fake: unknown notification setting ${settingId}`);
    return found;
  }

  const activeCount = () => [...settings.values()].filter(({ setting }) => setting.active).length;

  async function deliver(
    settingId: string,
    eventId: string,
    eventType: string,
    occurredAt: Instant,
    data: unknown,
    signedAt: Instant,
  ): Promise<FakePaddleDelivery> {
    const { setting, secret } = existingSetting(settingId);
    const notificationId = nextId("ntf");
    const rawBody = JSON.stringify({
      event_id: eventId,
      event_type: eventType,
      occurred_at: iso(occurredAt),
      notification_id: notificationId,
      data,
    });
    const signature = await signPaddleWebhook(secret, rawBody, Math.floor(signedAt / 1000));
    return {
      destination: setting.destination,
      settingId,
      eventId,
      eventType,
      notificationId,
      rawBody,
      signature,
    };
  }

  const fake: FakePaddle = {
    calls,

    async getApiRoot() {
      begin("getApiRoot");
      return {
        sellerId: seller.id,
        sellerName: seller.name,
        environment,
        authType: "api_key",
        permissions: [...permissions],
      };
    },

    async listPrices() {
      begin("listPrices");
      return structuredClone([...prices.values()]);
    },

    async getSubscription(subscriptionId) {
      paddleId("sub", subscriptionId);
      begin("getSubscription");
      const sub = subscriptions.get(subscriptionId);
      if (sub === undefined) throw notFound("get subscription");
      return read(sub);
    },

    async listSubscriptions() {
      begin("listSubscriptions");
      const newestFirst = [...subscriptions.values()].sort((a, b) => b.id.localeCompare(a.id));
      return {
        subscriptions: newestFirst.map((sub) => ({
          id: sub.id,
          status: sub.status,
          updatedAt: Date.parse(sub.updated_at),
        })),
        truncated: false,
      };
    },

    async listCustomerSubscriptions(customerId) {
      paddleId("ctm", customerId);
      begin("listCustomerSubscriptions");
      const newestFirst = [...subscriptions.values()]
        .filter((sub) => sub.customer_id === customerId)
        .sort((a, b) => b.id.localeCompare(a.id));
      return {
        subscriptions: newestFirst.map((sub) =>
          toCustomerSubscription(customerSubscriptionSchema.parse(structuredClone(sub))),
        ),
        truncated: false,
      };
    },

    async listCustomersByEmail(email) {
      emailFilter(email);
      begin("listCustomersByEmail");
      return [...customers.values()]
        .filter((customer) => customer.email === email)
        .map((c) => ({ ...c }));
    },

    async getCustomer(customerId) {
      paddleId("ctm", customerId);
      begin("getCustomer");
      const customer = customers.get(customerId);
      if (customer === undefined) throw notFound("get customer");
      return { ...customer };
    },

    async createTransaction({ priceId, customData }) {
      paddleId("pri", priceId);
      const body = customDataBody(customData);
      const operation = "createTransaction";
      begin(operation);
      if (prices.get(priceId)?.status !== "active") {
        throw rejected("create transaction", "invalid_field");
      }
      if (defaultPaymentLink === null) {
        throw rejected("create transaction", PaddleErrorCode.DefaultPaymentLinkNotSet);
      }
      const id = nextId("txn");
      const checkoutUrl = `${defaultPaymentLink}?_ptxn=${id}`;
      transactions.set(id, { id, priceId, customData: body, checkoutUrl, subscriptionId: null });
      return settle(operation, { id, checkoutUrl });
    },

    async createNotificationSetting({ description, destination, events }) {
      const operation = "createNotificationSetting";
      begin(operation);
      if (activeCount() >= DESTINATION_LIMIT) {
        throw rejected("create notification setting", PaddleErrorCode.DestinationLimitReached);
      }
      if ([...settings.values()].some(({ setting }) => setting.destination === destination)) {
        throw rejected("create notification setting", "notification_setting_cannot_be_duplicate");
      }
      const id = nextId("ntfset");
      const secret = `pdl_ntfset_${randomText(26)}_${randomText(32)}`;
      settings.set(id, {
        setting: { id, description, destination, active: true, events: [...events] },
        secret,
      });
      return settle(operation, { id, secret });
    },

    async getNotificationSetting(settingId) {
      paddleId("ntfset", settingId);
      begin("getNotificationSetting");
      const found = settings.get(settingId);
      if (found === undefined) throw notFound("get notification setting");
      return structuredClone(found.setting);
    },

    async listNotificationSettings() {
      begin("listNotificationSettings");
      // Paddle's default order is `id[DESC]`.
      return [...settings.values()]
        .map(({ setting }) => structuredClone(setting))
        .sort((a, b) => b.id.localeCompare(a.id));
    },

    async deleteNotificationSetting(settingId) {
      paddleId("ntfset", settingId);
      const operation = "deleteNotificationSetting";
      begin(operation);
      const deleted = settings.delete(settingId);
      return settle(operation, deleted ? ("deleted" as const) : ("not_found" as const));
    },

    addPrice(input = {}) {
      const price: PaddlePrice = {
        id: input.id ?? nextId("pri"),
        productId: input.productId ?? nextId("pro"),
        productName: input.productName ?? "Repository access",
        productDescription: input.productDescription ?? null,
        description: input.description ?? "Monthly",
        billingCycle:
          input.billingCycle === undefined
            ? { interval: "month", frequency: 1 }
            : input.billingCycle,
        unitAmount: input.unitAmount ?? "1000",
        currency: input.currency ?? "USD",
        status: input.status ?? "active",
      };
      prices.set(price.id, price);
      return { ...price };
    },

    archivePrice(priceId) {
      const price = prices.get(priceId);
      if (price === undefined) throw new Error(`fake: unknown price ${priceId}`);
      prices.set(priceId, { ...price, status: "archived" });
    },

    addCustomer({ id, email, createdAt }) {
      const customer = { id: id ?? nextId("ctm"), email, createdAt: createdAt ?? clock.now() };
      customers.set(customer.id, customer);
      return { ...customer };
    },

    setCustomerEmail(customerId, email) {
      const customer = customers.get(customerId);
      if (customer === undefined) throw new Error(`fake: unknown customer ${customerId}`);
      customers.set(customerId, { ...customer, email });
    },

    setDefaultPaymentLink(url) {
      defaultPaymentLink = url;
    },

    transaction(transactionId) {
      const found = transactions.get(transactionId);
      if (found === undefined) throw new Error(`fake: unknown transaction ${transactionId}`);
      return structuredClone(found);
    },

    completeCheckout(transactionId, { subscriptionId, ...buyer }) {
      const transaction = fake.transaction(transactionId);
      if (transaction.subscriptionId !== null) {
        throw new Error(`fake: transaction ${transactionId} is already completed`);
      }
      const customerId =
        "customerId" in buyer
          ? buyer.customerId
          : ([...customers.values()].find((customer) => customer.email === buyer.email)?.id ??
            fake.addCustomer({ email: buyer.email }).id);
      const created = create({
        ...(subscriptionId === undefined ? {} : { id: subscriptionId }),
        customerId,
        priceIds: [transaction.priceId],
        customData: { ...transaction.customData },
      });
      transactions.set(transactionId, { ...transaction, subscriptionId: created.id });
      return created;
    },

    createSubscription: create,

    activate(subscriptionId) {
      return change(subscriptionId, (sub, now) => {
        sub.status = "active";
        sub.first_billed_at ??= iso(now);
        setItemStatus(sub, "active");
        startPeriod(sub, now);
      });
    },

    markPastDue(subscriptionId) {
      return change(subscriptionId, (sub) => {
        sub.status = "past_due";
      });
    },

    scheduleCancel(subscriptionId, effectiveAt) {
      return change(subscriptionId, (sub) => {
        const at = periodEnd(sub, effectiveAt);
        sub.scheduled_change = { action: "cancel", effective_at: iso(at), resume_at: null };
        sub.next_billed_at = null;
      });
    },

    schedulePause(subscriptionId, effectiveAt) {
      return change(subscriptionId, (sub) => {
        const at = periodEnd(sub, effectiveAt);
        sub.scheduled_change = { action: "pause", effective_at: iso(at), resume_at: null };
      });
    },

    removeScheduledChange(subscriptionId) {
      return change(subscriptionId, (sub) => {
        sub.scheduled_change = null;
        sub.next_billed_at = sub.current_billing_period?.ends_at ?? null;
      });
    },

    cancelNow(subscriptionId) {
      return change(subscriptionId, (sub, now) => {
        sub.status = "canceled";
        sub.canceled_at = iso(now);
        sub.current_billing_period = null;
        sub.scheduled_change = null;
        sub.next_billed_at = null;
      });
    },

    pause(subscriptionId) {
      return change(subscriptionId, (sub, now) => {
        sub.status = "paused";
        sub.paused_at = iso(now);
        sub.current_billing_period = null;
        sub.scheduled_change = null;
        sub.next_billed_at = null;
      });
    },

    resume(subscriptionId) {
      return change(subscriptionId, (sub, now) => {
        sub.status = "active";
        sub.paused_at = null;
        setItemStatus(sub, "active");
        startPeriod(sub, now);
      });
    },

    renew(subscriptionId) {
      return change(subscriptionId, (sub, now) => {
        const from = sub.current_billing_period?.ends_at;
        sub.status = "active";
        setItemStatus(sub, "active");
        startPeriod(sub, from === undefined ? now : Date.parse(from));
      });
    },

    updateCustomData(subscriptionId, data) {
      return change(subscriptionId, (sub) => {
        sub.custom_data = data === null ? null : structuredClone(data);
      });
    },

    subscription(subscriptionId) {
      return read(wire(subscriptionId));
    },

    notificationSettings() {
      return [...settings.values()]
        .filter(({ foreign }) => foreign === undefined)
        .map(({ setting }) => structuredClone(setting));
    },

    addForeignDestinations(count) {
      for (let i = 0; i < count; i += 1) {
        const id = nextId("ntfset");
        const setting = {
          id,
          description: "Another app",
          destination: `https://other-app.example/paddle/${id}`,
          active: true,
          events: ["transaction.completed"],
        };
        settings.set(id, {
          setting,
          secret: `pdl_ntfset_${randomText(26)}_${randomText(32)}`,
          foreign: true,
        });
      }
    },

    deactivateNotificationSetting(settingId) {
      const found = existingSetting(settingId);
      found.setting = { ...found.setting, active: false };
    },

    secretOf(settingId) {
      return existingSetting(settingId).secret;
    },

    emit({ settingId, eventType, data, occurredAt, signedAt }) {
      const now = clock.now();
      return deliver(settingId, nextId("evt"), eventType, occurredAt ?? now, data, signedAt ?? now);
    },

    emitToAll({ eventType, data, occurredAt, signedAt }) {
      const now = clock.now();
      const eventId = nextId("evt");
      const active = [...settings.values()].filter(({ setting }) => setting.active);
      return Promise.all(
        active.map(({ setting }) =>
          deliver(setting.id, eventId, eventType, occurredAt ?? now, data, signedAt ?? now),
        ),
      );
    },

    emitSubscriptionEvent(settingId, eventType, subscriptionId) {
      return fake.emit({ settingId, eventType, data: structuredClone(wire(subscriptionId)) });
    },

    emitTransactionEvent(settingId, eventType, transactionId) {
      const transaction = fake.transaction(transactionId);
      const subscription =
        transaction.subscriptionId === null ? undefined : wire(transaction.subscriptionId);
      return fake.emit({
        settingId,
        eventType,
        data: {
          id: transaction.id,
          status: subscription === undefined ? "ready" : "completed",
          customer_id: subscription?.customer_id ?? null,
          subscription_id: transaction.subscriptionId,
          custom_data: transaction.customData,
          items: [{ price: { id: transaction.priceId }, quantity: 1 }],
        },
      });
    },

    replay(delivery) {
      const original = JSON.parse(delivery.rawBody) as { occurred_at: string; data: unknown };
      return deliver(
        delivery.settingId,
        delivery.eventId,
        delivery.eventType,
        Date.parse(original.occurred_at),
        original.data,
        clock.now(),
      );
    },

    revokeKey() {
      revoked = true;
    },

    restoreKey() {
      revoked = false;
    },

    setPermissions(next) {
      permissions = [...next];
    },

    failNext(operation, kind, details = {}) {
      const status = {
        unauthorized: 403,
        not_found: 404,
        rate_limited: 429,
        transient: 503,
        rejected: 400,
        malformed: 200,
      }[kind];
      failures.set(
        operation,
        new PaddleApiError(kind, `Paddle ${operation} failed (fake)`, {
          status,
          ...(kind === "rate_limited" ? { retryAfterMs: 60_000 } : {}),
          ...details,
        }),
      );
    },

    loseNextResponse(operation) {
      lostResponses.add(operation);
    },

    hangNext(operation) {
      hangs.add(operation);
    },

    outage(until) {
      outageUntil = until;
    },
  };
  return fake;
}
