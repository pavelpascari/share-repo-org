// A local stand-in for Paddle Billing's REST API, its checkout and its webhooks, for E2E only
// (decision 0011). Each seller is one in-memory FakePaddle (@sharerepo/integrations/testing),
// the same state engine the unit tests use, behind one API key; this file is the HTTP layer:
// Paddle's wire format, its error body, signed webhook deliveries, a default payment link page,
// lifecycle controls and a mailbox for ShareRepo's claim emails (MAIL_CAPTURE_URL).
//
// - `/api/…`: the endpoints ShareRepo's Paddle client calls, keyed by `Authorization: Bearer`.
// - `/pay?_ptxn=txn_…`: every seller's default payment link. "Pay" creates or reuses the customer
//   by email, creates the subscription with the transaction's custom data, and delivers signed
//   `transaction.completed`, `subscription.created` and `subscription.activated` webhooks.
// - `POST /mail`: captures ShareRepo's outgoing mail.
// - `/_control/…`: what tests and people drive (forms or JSON); see docs/local-setup.md.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  PaddleNotificationSetting,
  PaddlePrice,
  PaddleSubscription,
} from "@sharerepo/integrations";
import { PaddleApiError } from "@sharerepo/integrations";
import {
  createFakePaddle,
  type FakePaddle,
  type FakePaddleDelivery,
} from "@sharerepo/integrations/testing";
import { FAKE_PADDLE_PORT } from "./ports.ts";

interface Seller {
  readonly id: string;
  readonly key: string;
  readonly fake: FakePaddle;
  /** The catalog, for the payment page, which needs no key (the seller's may be revoked). */
  readonly prices: Map<string, PaddlePrice>;
  /** Scheduled cancellations the fake applies at their effective time, by subscription. */
  readonly timers: Map<string, NodeJS.Timeout>;
}

interface DeliveryRecord {
  readonly sellerId: string;
  readonly eventType: string;
  readonly eventId: string;
  readonly destination: string;
  readonly status: number;
}

interface Mail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Scheduled cancellations further away than this are left for a test to apply. */
const MAX_TIMER_MS = 10 * 60 * 1000;
const iso = (at: number) => new Date(at).toISOString();

export function startFakePaddle(options: { port?: number } = {}) {
  const port = options.port ?? FAKE_PADDLE_PORT;
  const base = `http://localhost:${port}`;
  const sellers = new Map<string, Seller>();
  const byKey = new Map<string, Seller>();
  const deliveries: DeliveryRecord[] = [];
  const mailbox: Mail[] = [];
  let sellerCount = 0;

  function seller(id: string): Seller {
    const found = sellers.get(id);
    if (found === undefined) throw new ControlError(404, `unknown seller ${id}`);
    return found;
  }

  /** The seller whose fake holds this entity: IDs are unique across sellers (their ID seed). */
  function sellerOf(find: (fake: FakePaddle) => unknown): Seller {
    for (const candidate of sellers.values()) {
      try {
        find(candidate.fake);
        return candidate;
      } catch {
        // Not this seller's.
      }
    }
    throw new ControlError(404, "unknown entity");
  }

  /** Delivers one event to every active destination of the seller subscribed to it. */
  async function broadcast(
    owner: Seller,
    eventType: string,
    make: (settingId: string) => Promise<FakePaddleDelivery>,
  ): Promise<DeliveryRecord[]> {
    const sent: DeliveryRecord[] = [];
    for (const setting of owner.fake.notificationSettings()) {
      if (!setting.active || !setting.events.includes(eventType)) continue;
      const delivery = await make(setting.id);
      let status = 0;
      try {
        const response = await fetch(delivery.destination, {
          method: "POST",
          headers: { "content-type": "application/json", "paddle-signature": delivery.signature },
          body: delivery.rawBody,
        });
        status = response.status;
      } catch {
        // Unreachable destination: recorded as status 0. Paddle would retry; tests resend.
      }
      const record = {
        sellerId: owner.id,
        eventType,
        eventId: delivery.eventId,
        destination: delivery.destination,
        status,
      };
      deliveries.push(record);
      sent.push(record);
    }
    return sent;
  }

  const subscriptionEvent = (owner: Seller, eventType: string, subscriptionId: string) =>
    broadcast(owner, eventType, (settingId) =>
      owner.fake.emitSubscriptionEvent(settingId, eventType, subscriptionId),
    );

  function clearTimer(owner: Seller, subscriptionId: string): void {
    clearTimeout(owner.timers.get(subscriptionId));
    owner.timers.delete(subscriptionId);
  }

  /** A subscription lifecycle change, then the event Paddle sends for it. */
  async function lifecycle(subscriptionId: string, action: string, fields: Fields) {
    const owner = sellerOf((fake) => fake.subscription(subscriptionId));
    const { fake } = owner;
    let eventType: string;
    switch (action) {
      case "schedule-cancel": {
        clearTimer(owner, subscriptionId);
        const inSeconds = fields.effective_in_seconds;
        const effectiveAt =
          inSeconds !== undefined
            ? Date.now() + Number(inSeconds) * 1000
            : fields.effective_at !== undefined
              ? Date.parse(fields.effective_at)
              : undefined;
        const scheduled = fake.scheduleCancel(subscriptionId, effectiveAt);
        eventType = "subscription.updated";
        // Paddle cancels at the effective time and sends subscription.canceled.
        const delay = (scheduled.scheduledChange?.effectiveAt ?? 0) - Date.now();
        if (delay <= MAX_TIMER_MS) {
          const timer = setTimeout(
            () => {
              owner.timers.delete(subscriptionId);
              if (fake.subscription(subscriptionId).scheduledChange?.action !== "cancel") return;
              fake.cancelNow(subscriptionId);
              void subscriptionEvent(owner, "subscription.canceled", subscriptionId);
            },
            Math.max(0, delay),
          );
          owner.timers.set(subscriptionId, timer);
        }
        break;
      }
      case "remove-scheduled-change":
        clearTimer(owner, subscriptionId);
        fake.removeScheduledChange(subscriptionId);
        eventType = "subscription.updated";
        break;
      case "cancel":
        clearTimer(owner, subscriptionId);
        fake.cancelNow(subscriptionId);
        eventType = "subscription.canceled";
        break;
      case "past-due":
        fake.markPastDue(subscriptionId);
        eventType = "subscription.past_due";
        break;
      case "renew":
        fake.renew(subscriptionId);
        eventType = "subscription.updated";
        break;
      case "activate":
        fake.activate(subscriptionId);
        eventType = "subscription.activated";
        break;
      case "pause":
        fake.pause(subscriptionId);
        eventType = "subscription.paused";
        break;
      case "resume":
        fake.resume(subscriptionId);
        eventType = "subscription.resumed";
        break;
      default:
        throw new ControlError(404, `unknown action ${action}`);
    }
    const sent = await subscriptionEvent(owner, eventType, subscriptionId);
    return { subscription: subscriptionWire(fake.subscription(subscriptionId)), deliveries: sent };
  }

  function registerSeller(fields: Fields) {
    const key = fields.key ?? "";
    if (byKey.has(key)) throw new ControlError(409, "key already registered");
    sellerCount += 1;
    const seed = `e2e${sellerCount.toString(36).padStart(4, "0")}`;
    const id = `slr_${seed}${"1".padStart(26 - seed.length, "0")}`;
    const permissions = fields.permissions
      ?.split(",")
      .map((permission) => permission.trim())
      .filter((permission) => permission !== "");
    const fake = createFakePaddle({
      idSeed: seed,
      seller: { id, name: fields.name ?? "Fake Seller" },
      ...(permissions === undefined ? {} : { permissions }),
      defaultPaymentLink: `${base}/pay`,
    });
    const created: Seller = { id, key, fake, prices: new Map(), timers: new Map() };
    sellers.set(id, created);
    byKey.set(key, created);
    return { sellerId: id };
  }

  async function api(req: IncomingMessage, path: string, query: URLSearchParams, body: string) {
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const owner = byKey.get(key);
    // Paddle answers an unknown key with 403 `forbidden`.
    if (owner === undefined) throw new PaddleApiError("unauthorized", "fake", { status: 403 });
    const { fake } = owner;
    const method = req.method ?? "GET";
    const [resource = "", id] = path.split("/").filter((part) => part !== "");
    const statuses = query.get("status")?.split(",");

    if (method === "GET" && resource === "") {
      const root = await fake.getApiRoot();
      return single({
        api: { environment: root.environment === "live" ? "production" : "sandbox" },
        caller: {
          auth_type: root.authType,
          account: { id: root.sellerId, name: root.sellerName },
          permissions: root.permissions,
        },
      });
    }
    if (method === "GET" && resource === "prices" && id === undefined) {
      const prices = await fake.listPrices();
      return list(
        prices.filter((price) => statuses?.includes(price.status) ?? true).map(priceWire),
      );
    }
    if (method === "GET" && resource === "subscriptions" && id !== undefined) {
      return single(subscriptionWire(await fake.getSubscription(id)));
    }
    if (method === "GET" && resource === "subscriptions") {
      const customerId = query.get("customer_id");
      const ids =
        customerId === null
          ? (await fake.listSubscriptions()).subscriptions.map((sub) => sub.id)
          : (await fake.listCustomerSubscriptions(customerId)).subscriptions.map((sub) => sub.id);
      return list(
        ids
          .map((subscriptionId) => fake.subscription(subscriptionId))
          .filter((sub) => statuses?.includes(sub.status) ?? true)
          .map(subscriptionWire),
      );
    }
    if (method === "GET" && resource === "customers" && id !== undefined) {
      return single(customerWire(await fake.getCustomer(id)));
    }
    if (method === "GET" && resource === "customers") {
      // A comma-separated list of exact addresses (research § 6).
      const emails = (query.get("email") ?? "").split(",").filter((email) => email !== "");
      const found = [];
      for (const email of emails) found.push(...(await fake.listCustomersByEmail(email)));
      return list(found.map(customerWire));
    }
    if (method === "POST" && resource === "transactions") {
      const input = JSON.parse(body) as {
        items?: { price_id?: string }[];
        custom_data?: Record<string, string>;
      };
      const created = await fake.createTransaction({
        priceId: input.items?.[0]?.price_id ?? "",
        customData: input.custom_data ?? {},
      });
      return single({ id: created.id, status: "ready", checkout: { url: created.checkoutUrl } });
    }
    if (method === "POST" && resource === "notification-settings") {
      const input = JSON.parse(body) as {
        description?: string;
        destination?: string;
        subscribed_events?: string[];
      };
      const created = await fake.createNotificationSetting({
        description: input.description ?? "",
        destination: input.destination ?? "",
        events: input.subscribed_events ?? [],
      });
      const setting = await fake.getNotificationSetting(created.id);
      return single({ ...settingWire(setting), endpoint_secret_key: created.secret });
    }
    if (method === "GET" && resource === "notification-settings" && id === undefined) {
      return list((await fake.listNotificationSettings()).map(settingWire));
    }
    if (method === "GET" && resource === "notification-settings" && id !== undefined) {
      return single(settingWire(await fake.getNotificationSetting(id)));
    }
    if (method === "DELETE" && resource === "notification-settings" && id !== undefined) {
      if ((await fake.deleteNotificationSetting(id)) === "not_found") {
        throw new PaddleApiError("not_found", "fake", { status: 404, paddleCode: "not_found" });
      }
      return null;
    }
    throw new PaddleApiError("not_found", "fake", { status: 404, paddleCode: "not_found" });
  }

  async function control(method: string, parts: string[], query: URLSearchParams, body: Fields) {
    const [area, id, action] = parts;
    if (method === "POST" && area === "sellers" && id === undefined) return registerSeller(body);
    if (area === "sellers" && id !== undefined) {
      const owner = seller(id);
      if (method === "GET" && action === undefined) {
        const { subscriptions } = await owner.fake.listSubscriptions();
        return {
          sellerId: owner.id,
          subscriptions: subscriptions.map((sub) =>
            subscriptionWire(owner.fake.subscription(sub.id)),
          ),
          notificationSettings: owner.fake.notificationSettings(),
          deliveries: deliveries.filter((delivery) => delivery.sellerId === owner.id),
        };
      }
      if (method === "POST" && action === "prices") {
        const price = owner.fake.addPrice({
          productName: body.product_name ?? "Course access",
          description: body.description ?? "Monthly",
          unitAmount: body.amount ?? "1000",
          currency: body.currency ?? "USD",
          billingCycle:
            body.interval === "none"
              ? null
              : {
                  interval: (body.interval ?? "month") as "day" | "week" | "month" | "year",
                  frequency: Number(body.frequency ?? "1"),
                },
        });
        owner.prices.set(price.id, price);
        return priceWire(price);
      }
      if (method === "POST" && action === "revoke-key") {
        owner.fake.revokeKey();
        return { revoked: true };
      }
      if (method === "POST" && action === "restore-key") {
        owner.fake.restoreKey();
        return { revoked: false };
      }
      if (method === "POST" && action === "transactions") {
        // A checkout the creator shared from Paddle directly: no ShareRepo reference.
        const created = await owner.fake.createTransaction({
          priceId: body.price_id ?? "",
          customData:
            body.custom_data === undefined
              ? { source: "shared-link" }
              : (JSON.parse(body.custom_data) as Record<string, string>),
        });
        return { id: created.id, checkout_url: created.checkoutUrl };
      }
      if (method === "POST" && action === "events") {
        const eventType = body.event_type ?? "";
        const subscriptionId = body.subscription_id;
        const data = JSON.parse(body.data ?? "{}") as Record<string, unknown>;
        const sent = await broadcast(owner, eventType, (settingId) =>
          subscriptionId === undefined
            ? owner.fake.emit({ settingId, eventType, data })
            : owner.fake.emitSubscriptionEvent(settingId, eventType, subscriptionId),
        );
        return { deliveries: sent };
      }
    }
    if (method === "POST" && area === "subscriptions" && id !== undefined && action) {
      return lifecycle(id, action, body);
    }
    if (method === "GET" && area === "mail") {
      const to = query.get("to");
      return mailbox.filter((mail) => to === null || mail.to === to);
    }
    throw new ControlError(404, "unknown control");
  }

  async function pay(method: string, query: URLSearchParams, body: Fields, res: ServerResponse) {
    const transactionId = query.get("_ptxn") ?? "";
    const owner = sellerOf((fake) => fake.transaction(transactionId));
    const transaction = owner.fake.transaction(transactionId);
    const price = owner.prices.get(transaction.priceId) as PaddlePrice;
    if (method === "GET") {
      const action = `/pay?_ptxn=${encodeURIComponent(transactionId)}`;
      return html(
        res,
        200,
        `<h1>Checkout</h1>
        <p>${escapeHtml(price.productName)} (${escapeHtml(price.description)}): ${escapeHtml(money(price))}</p>
        ${transaction.subscriptionId === null ? "" : "<p>This transaction is already paid.</p>"}
        <form method="post" action="${action}">
          <label>Email <input name="email" type="email" required></label>
          <button type="submit">Pay</button>
        </form>`,
      );
    }
    if (transaction.subscriptionId !== null) {
      return html(res, 409, "<h1>Already paid</h1>");
    }
    const subscription = owner.fake.completeCheckout(transactionId, { email: body.email ?? "" });
    await broadcast(owner, "transaction.completed", (settingId) =>
      owner.fake.emitTransactionEvent(settingId, "transaction.completed", transactionId),
    );
    await subscriptionEvent(owner, "subscription.created", subscription.id);
    await subscriptionEvent(owner, "subscription.activated", subscription.id);
    return html(
      res,
      200,
      `<h1>Payment complete</h1><p>Subscription <code>${subscription.id}</code></p>`,
    );
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const raw = await readBody(req);
    const method = req.method ?? "GET";
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const value = await api(req, url.pathname.slice(4), url.searchParams, raw);
        if (value === null) {
          res.writeHead(204);
          return res.end();
        }
        return json(res, method === "POST" ? 201 : 200, value);
      }
      if (url.pathname === "/pay") {
        return await pay(method, url.searchParams, fields(req, raw), res);
      }
      if (method === "POST" && url.pathname === "/mail") {
        mailbox.push(JSON.parse(raw) as Mail);
        return json(res, 202, { accepted: true });
      }
      if (url.pathname.startsWith("/_control/")) {
        const parts = url.pathname.split("/").slice(2).filter(Boolean);
        return json(res, 200, await control(method, parts, url.searchParams, fields(req, raw)));
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof PaddleApiError) {
        const status = error.status ?? 400;
        return json(res, status, {
          error: {
            type: "request_error",
            code: error.paddleCode ?? (status === 403 ? "forbidden" : "bad_request"),
            detail: "Fake Paddle refused the request.",
          },
          meta: { request_id: "fake" },
        });
      }
      if (error instanceof ControlError) return json(res, error.status, { error: error.message });
      return json(res, 500, { error: error instanceof Error ? error.message : "failed" });
    }
  });
  server.listen(port);
  return server;
}

class ControlError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Fields = Record<string, string | undefined>;

/** A control's input, as a form or as JSON (string values). */
function fields(req: IncomingMessage, raw: string): Fields {
  if (raw === "") return {};
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Paddle's wire format (developer.paddle.com/api-reference), from the fake's port types --------

function priceWire(price: PaddlePrice) {
  return {
    id: price.id,
    product_id: price.productId,
    type: "standard",
    description: price.description,
    billing_cycle: price.billingCycle,
    trial_period: null,
    unit_price: { amount: price.unitAmount, currency_code: price.currency },
    status: price.status,
    product: {
      id: price.productId,
      name: price.productName,
      description: price.productDescription,
      status: "active",
    },
  };
}

function subscriptionWire(sub: PaddleSubscription) {
  const period = sub.currentBillingPeriod;
  const change = sub.scheduledChange;
  return {
    id: sub.id,
    status: sub.status,
    customer_id: sub.customerId,
    items: sub.items.map((item) => ({
      status: item.status,
      quantity: 1,
      recurring: true,
      price: { id: item.priceId },
    })),
    current_billing_period: period && {
      starts_at: iso(period.startsAt),
      ends_at: iso(period.endsAt),
    },
    scheduled_change: change && {
      action: change.action,
      effective_at: iso(change.effectiveAt),
      resume_at: null,
    },
    canceled_at: sub.canceledAt === null ? null : iso(sub.canceledAt),
    updated_at: iso(sub.updatedAt),
    custom_data: sub.customData,
  };
}

function customerWire(customer: { id: string; email: string; createdAt: number }) {
  return {
    id: customer.id,
    email: customer.email,
    status: "active",
    created_at: iso(customer.createdAt),
  };
}

function settingWire(setting: PaddleNotificationSetting) {
  return {
    id: setting.id,
    description: setting.description,
    type: "url",
    destination: setting.destination,
    active: setting.active,
    api_version: 1,
    subscribed_events: setting.events.map((name) => ({ name })),
  };
}

const single = (data: unknown) => ({ data, meta: { request_id: "fake" } });

/** One page with everything: the fake's lists are short. */
const list = (data: unknown[]) => ({
  data,
  meta: {
    request_id: "fake",
    pagination: { per_page: 200, next: null, has_more: false, estimated_total: data.length },
  },
});

function money(price: PaddlePrice): string {
  const amount = (Number(price.unitAmount) / 100).toFixed(2);
  const cycle = price.billingCycle;
  return cycle === null
    ? `${amount} ${price.currency}`
    : `${amount} ${price.currency} per ${cycle.interval}`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Fake Paddle</title>${body}`);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
