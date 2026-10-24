import type { CommercialSource, Instant, SubscriptionState } from "@sharerepo/domain";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, conditionalAuditInserts } from "./audit-repository.ts";
import { runBatch, type Statement } from "./batch.ts";
import { type ClaimConsumption, consumeForLink } from "./claim-repository.ts";
import type { Db } from "./client.ts";
import { conditionalOutboxInsert, type NewOutboxRow } from "./outbox-repository.ts";
import { customers, subjects, subscriptions } from "./schema/index.ts";

/**
 * Domain `Customer`: a commercial identity within a source. Customers are created as part of a
 * subscription refresh (`applySubscriptionRefresh`), in the same batch as the subscription; a
 * claim or an owner links one to a subject with `applyCustomerLink`.
 */
export type Customer = typeof customers.$inferSelect;

export async function findCustomer(
  db: Db,
  key: { workspaceId: string; source: CommercialSource; externalCustomerId: string },
): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.workspaceId, key.workspaceId),
        eq(customers.source, key.source),
        eq(customers.externalCustomerId, key.externalCustomerId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getCustomer(
  db: Db,
  key: { workspaceId: string; customerId: string },
): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.workspaceId, key.workspaceId), eq(customers.id, key.customerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** A customer's subscription as the Customers page shows it. */
export interface CustomerSubscriptionSummary {
  id: string;
  externalSubscriptionId: string;
  state: SubscriptionState;
  cancelAt: Instant | null;
  endedAt: Instant | null;
}

/** A customer with the subject it is linked to, and its subscriptions' states. */
export interface CustomerWithLink {
  customer: Customer;
  /** The linked subject, or null when the customer is not claimed. */
  subject: { id: string; externalSubjectId: string; login: string } | null;
  subscriptions: CustomerSubscriptionSummary[];
}

/**
 * The workspace's customers (of every source, oldest first), each with its linked subject and
 * its subscriptions (by external ID): what the Customers page shows. Never an email or a name.
 */
export async function listCustomersWithLinks(
  db: Db,
  key: { workspaceId: string },
): Promise<CustomerWithLink[]> {
  const { workspaceId } = key;
  const [rows, subscriptionRows] = await Promise.all([
    db
      .select({ customer: customers, subject: subjects })
      .from(customers)
      .leftJoin(
        subjects,
        and(eq(subjects.workspaceId, customers.workspaceId), eq(subjects.id, customers.subjectId)),
      )
      .where(eq(customers.workspaceId, workspaceId))
      .orderBy(asc(customers.createdAt), asc(customers.id)),
    db
      .select({
        customerId: subscriptions.customerId,
        id: subscriptions.id,
        externalSubscriptionId: subscriptions.externalSubscriptionId,
        state: subscriptions.state,
        cancelAt: subscriptions.cancelAt,
        endedAt: subscriptions.endedAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .orderBy(asc(subscriptions.externalSubscriptionId), asc(subscriptions.id)),
  ]);
  const byCustomer = new Map<string, CustomerSubscriptionSummary[]>();
  for (const { customerId, ...subscription } of subscriptionRows) {
    const list = byCustomer.get(customerId) ?? [];
    list.push(subscription);
    byCustomer.set(customerId, list);
  }
  return rows.map(({ customer, subject }) => ({
    customer,
    subject:
      subject === null
        ? null
        : {
            id: subject.id,
            externalSubjectId: subject.externalSubjectId,
            login: subject.loginSnapshot,
          },
    subscriptions: byCustomer.get(customer.id) ?? [],
  }));
}

export type ApplyCustomerLinkResult =
  | { ok: true }
  /**
   * The customer is no longer linked to `expectedSubjectId` (or does not exist in this
   * workspace), or the claim the link consumes is no longer usable: nothing was written.
   */
  | { ok: false; reason: "stale" };

/**
 * Links a customer to `subjectId` (a claim, a relink or a manual link, as the domain's
 * `decideCustomerLink` decided), in one batch guarded on the customer still being linked to
 * `expectedSubjectId` (null: unlinked):
 *
 * 1. the audit events, and a `refresh_subscription` (built by `makeRefreshRow`) for each of the
 *    customer's subscriptions, so their entitlements follow the new link. Not deduplicated: a
 *    refresh that is queued or already running may have read the old link (a link made during a
 *    refresh, by its claim reference, is one), so a fresh one must follow it;
 * 2. the link itself: once it runs, the guard no longer holds;
 * 3. with `consume`, the single-use claim behind the link, consumed only if statement 2 linked.
 *
 * With `consume`, the guard also requires the claim to be usable (unused, unexpired, for this
 * customer), so a used or expired claim links nothing. The subscriptions are read before the batch; one recorded after that read
 * is refreshed with the link already in place. The subject must belong to the workspace: the
 * composite foreign key rejects any other, and the batch then fails as a whole.
 */
export async function applyCustomerLink(
  db: Db,
  input: {
    workspaceId: string;
    customerId: string;
    expectedSubjectId: string | null;
    subjectId: string;
    now: Instant;
    makeRefreshRow: (subscription: {
      source: CommercialSource;
      externalSubscriptionId: string;
    }) => NewOutboxRow;
    consume?: ClaimConsumption;
  },
  audit: AuditEvents,
): Promise<ApplyCustomerLinkResult> {
  const { workspaceId, customerId, now } = input;
  const current = and(
    eq(customers.workspaceId, workspaceId),
    eq(customers.id, customerId),
    input.expectedSubjectId === null
      ? isNull(customers.subjectId)
      : eq(customers.subjectId, input.expectedSubjectId),
  ) as SQL;
  const consumption =
    input.consume === undefined
      ? null
      : consumeForLink(db, { workspaceId, customerId, now, consumption: input.consume });
  const guard = consumption === null ? current : (and(current, consumption.usable) as SQL);
  const owned = await db
    .select({
      source: subscriptions.source,
      externalSubscriptionId: subscriptions.externalSubscriptionId,
    })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.customerId, customerId)),
    )
    .orderBy(asc(subscriptions.id));
  const applicable = sql`EXISTS (SELECT 1 FROM ${customers} WHERE ${guard})`;
  const statements: Statement[] = [
    ...conditionalAuditInserts(db, audit, applicable),
    ...owned.map((subscription) =>
      conditionalOutboxInsert(db, input.makeRefreshRow(subscription), applicable),
    ),
    db.update(customers).set({ subjectId: input.subjectId, updatedAt: now }).where(guard),
  ];
  // Immediately after the link: it consumes the claim only if the link was made.
  if (consumption !== null) statements.push(consumption.consume);
  const changes = await runBatch(db, statements);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}
