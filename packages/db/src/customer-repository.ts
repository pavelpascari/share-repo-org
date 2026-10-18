import type { CommercialSource } from "@sharerepo/domain";
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { customers } from "./schema/index.ts";

/**
 * Domain `Customer`: a commercial identity within a source. Customers are written only as part of
 * a subscription refresh (`applySubscriptionRefresh`), in the same batch as the subscription.
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
