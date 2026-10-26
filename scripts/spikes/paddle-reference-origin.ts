// Paddle sandbox spike: can ShareRepo tell that a checkout reference reached a subscription
// outside its own checkout? (docs/research/paddle-reference-origin-spike.md; decision 0016, open
// item). Run by a human against their own Paddle sandbox. Never runs in CI. Read-only.
//
//   PADDLE_SANDBOX_API_KEY=pdl_sdbx_apikey_… pnpm spike:paddle-origin --subscription sub_… [--transaction txn_…]
//
// Safety: it prints an allow-list of non-personal fields only (IDs, status, origin, timestamps,
// the custom data keys present, and a short digest of a claim reference so two can be compared
// without printing either). Never the key, an email, a name, an address or a custom data value.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const API_KEY_VARIABLE = "PADDLE_SANDBOX_API_KEY";
export const SANDBOX_API = "https://sandbox-api.paddle.com";
/** The custom data key ShareRepo's checkout sets (decision 0012). */
const REFERENCE_KEY = "sharerepo_claim";
const EVENTS_PAGE = 200;

const USAGE =
  `Usage: ${API_KEY_VARIABLE}=<sandbox key> pnpm spike:paddle-origin --subscription sub_… [--transaction txn_…]\n` +
  "Read-only. See docs/research/paddle-reference-origin-spike.md.";

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

/** An ID-shaped string (Paddle IDs are `prefix_` plus lowercase letters and digits), or null. */
function id(value: unknown): string | null {
  return typeof value === "string" && /^[a-z]{2,5}_[a-z0-9]{1,40}$/.test(value) ? value : null;
}

/** An RFC 3339 timestamp, or null; anything else is not printed. */
function timestamp(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? value : null;
}

/** A short lowercase word (status, origin, event type), or null. */
function word(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_.]{1,40}$/.test(value) ? value : null;
}

/** The custom data's keys (never its values), and a 12-hex digest of the claim reference. */
export function customData(value: unknown): { keys: string[]; referenceDigest: string | null } {
  const data = record(value);
  const keys = Object.keys(data)
    .filter((key) => /^[A-Za-z0-9_.-]{1,40}$/.test(key))
    .sort();
  const reference = data[REFERENCE_KEY];
  return {
    keys,
    referenceDigest:
      typeof reference === "string"
        ? createHash("sha256").update(reference).digest("hex").slice(0, 12)
        : null,
  };
}

export interface SubscriptionSummary {
  id: string | null;
  status: string | null;
  customerId: string | null;
  customData: { keys: string[]; referenceDigest: string | null };
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  firstBilledAt: string | null;
}

/** The allow-listed fields of a `GET /subscriptions/{id}` response's `data`. */
export function summarizeSubscription(value: unknown): SubscriptionSummary {
  const s = record(value);
  return {
    id: id(s.id),
    status: word(s.status),
    customerId: id(s.customer_id),
    customData: customData(s.custom_data),
    createdAt: timestamp(s.created_at),
    updatedAt: timestamp(s.updated_at),
    startedAt: timestamp(s.started_at),
    firstBilledAt: timestamp(s.first_billed_at),
  };
}

export interface TransactionSummary {
  id: string | null;
  status: string | null;
  origin: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  customData: { keys: string[]; referenceDigest: string | null };
  createdAt: string | null;
  updatedAt: string | null;
  billedAt: string | null;
}

/** The allow-listed fields of a transaction (`GET /transactions/{id}` or a list item). */
export function summarizeTransaction(value: unknown): TransactionSummary {
  const t = record(value);
  return {
    id: id(t.id),
    status: word(t.status),
    origin: word(t.origin),
    subscriptionId: id(t.subscription_id),
    customerId: id(t.customer_id),
    customData: customData(t.custom_data),
    createdAt: timestamp(t.created_at),
    updatedAt: timestamp(t.updated_at),
    billedAt: timestamp(t.billed_at),
  };
}

export interface EventSummary {
  eventId: string | null;
  eventType: string | null;
  occurredAt: string | null;
  entityId: string | null;
  transactionId: string | null;
  origin: string | null;
  referenceDigest: string | null;
}

/**
 * The events of a `GET /events` page that concern the subscription (its own events, and those of
 * its transactions), oldest first, allow-listed.
 */
export function summarizeEvents(value: unknown, subscriptionId: string): EventSummary[] {
  const events = Array.isArray(value) ? value : [];
  return events
    .map(record)
    .filter((event) => {
      const data = record(event.data);
      return data.id === subscriptionId || data.subscription_id === subscriptionId;
    })
    .map((event) => {
      const data = record(event.data);
      return {
        eventId: id(event.event_id),
        eventType: word(event.event_type),
        occurredAt: timestamp(event.occurred_at),
        entityId: id(data.id),
        transactionId: id(data.transaction_id),
        origin: word(data.origin),
        referenceDigest: customData(data.custom_data).referenceDigest,
      };
    })
    .sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""));
}

export interface Arguments {
  subscriptionId: string;
  transactionId: string | null;
}

/** `--subscription sub_…` (required) and `--transaction txn_…` (optional); null when invalid. */
export function parseArguments(argv: readonly string[]): Arguments | null {
  const flagValue = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : (argv[index + 1] ?? "");
  };
  const subscriptionId = id(flagValue("--subscription"));
  const transaction = flagValue("--transaction");
  const transactionId = transaction === undefined ? null : id(transaction);
  if (subscriptionId === null || (transaction !== undefined && transactionId === null)) {
    return null;
  }
  return { subscriptionId, transactionId };
}

export interface Report {
  subscription: SubscriptionSummary;
  /** The transaction named on the command line (ShareRepo's checkout transaction), if any. */
  checkoutTransaction: TransactionSummary | null;
  /** Every transaction Paddle lists for the subscription, oldest first. */
  subscriptionTransactions: TransactionSummary[];
  /** Events concerning the subscription on the latest events page, oldest first. */
  events: EventSummary[];
  /** The latest events page was full, so older events may be missing. */
  eventsTruncated: boolean;
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/** Reads what the spike needs from the sandbox. Errors name the endpoint and status only. */
export async function collect(args: Arguments, apiKey: string, fetch: Fetch): Promise<Report> {
  const get = async (path: string): Promise<{ data: unknown }> => {
    const response = await fetch(`${SANDBOX_API}${path}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${path.split("?")[0]} answered ${response.status}`);
    }
    return (await response.json()) as { data: unknown };
  };
  const sub = args.subscriptionId;
  const subscription = await get(`/subscriptions/${sub}`);
  const checkout =
    args.transactionId === null ? null : await get(`/transactions/${args.transactionId}`);
  const listed = await get(
    `/transactions?subscription_id=${sub}&order_by=created_at[ASC]&per_page=50`,
  );
  const events = await get(`/events?per_page=${EVENTS_PAGE}`);
  const transactions = Array.isArray(listed.data) ? listed.data : [];
  const eventItems = Array.isArray(events.data) ? events.data : [];
  return {
    subscription: summarizeSubscription(subscription.data),
    checkoutTransaction: checkout === null ? null : summarizeTransaction(checkout.data),
    subscriptionTransactions: transactions.map(summarizeTransaction),
    events: summarizeEvents(eventItems, sub),
    eventsTruncated: eventItems.length >= EVENTS_PAGE,
  };
}

/** Runs the spike: the report as JSON on `print`, or a usage or error line; returns the exit code. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fetch: Fetch,
  print: (line: string) => void,
): Promise<number> {
  const args = parseArguments(argv);
  const apiKey = env[API_KEY_VARIABLE];
  if (args === null || apiKey === undefined || !apiKey.startsWith("pdl_sdbx_apikey_")) {
    print(USAGE);
    return 2;
  }
  try {
    print(JSON.stringify(await collect(args, apiKey, fetch), null, 2));
    return 0;
  } catch (error) {
    // Our own messages only (endpoint and status); never a response body.
    print(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

/* v8 ignore next 4 -- the command-line entry point; main() is tested */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fetch: Fetch = (url, init) => globalThis.fetch(url, init);
  process.exitCode = await main(process.argv.slice(2), process.env, fetch, console.log);
}
