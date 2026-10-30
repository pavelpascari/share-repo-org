import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  auditEvents,
  connections,
  customers,
  entitlements,
  externalIdentities,
  grants,
  manualAccesses,
  offerAccesses,
  offerItems,
  offers,
  offerVersions,
  paddleConnections,
  paddlePrices,
  resources,
  subjects,
  subscriptionItems,
  subscriptions,
  workspaceMemberships,
  workspaces,
} from "./schema/index.ts";

// The workspace export (decision 0015, threat O6). Every table is read through an explicit
// allow-list of columns, never `SELECT *`: envelopes, token and email hashes, claim references,
// emails and lease tokens are never selected. Claims, claim requests and claim tokens are not
// exported at all. New columns stay out until they are added here deliberately.

/** Reads everything the export contains for one workspace, every query scoped by its ID. */
export async function readWorkspaceExport(db: Db, workspaceId: string) {
  const [workspace] = await db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      status: workspaces.status,
      createdAt: workspaces.createdAt,
      deleteAfter: workspaces.deleteAfter,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const members = await db
    .select({
      userId: workspaceMemberships.userId,
      role: workspaceMemberships.role,
      login: externalIdentities.usernameSnapshot,
      createdAt: workspaceMemberships.createdAt,
    })
    .from(workspaceMemberships)
    .leftJoin(
      externalIdentities,
      sql`${externalIdentities.userId} = ${workspaceMemberships.userId} AND ${externalIdentities.provider} = 'github'`,
    )
    .where(eq(workspaceMemberships.workspaceId, workspaceId))
    .orderBy(asc(workspaceMemberships.createdAt), asc(workspaceMemberships.userId));
  const githubConnections = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      installationId: connections.installationId,
      accountExternalId: connections.accountExternalId,
      accountLogin: connections.accountLoginSnapshot,
      accountType: connections.accountType,
      status: connections.status,
      createdByUserId: connections.createdByUserId,
      createdAt: connections.createdAt,
      lastSyncedAt: connections.lastSyncedAt,
    })
    .from(connections)
    .where(eq(connections.workspaceId, workspaceId))
    .orderBy(asc(connections.createdAt), asc(connections.id));
  const paddle = await db
    .select({
      id: paddleConnections.id,
      environment: paddleConnections.environment,
      sellerId: paddleConnections.sellerId,
      sellerName: paddleConnections.sellerName,
      status: paddleConnections.status,
      statusReason: paddleConnections.statusReason,
      apiKeyExpiresOn: paddleConnections.apiKeyExpiresOn,
      createdAt: paddleConnections.createdAt,
      updatedAt: paddleConnections.updatedAt,
    })
    .from(paddleConnections)
    .where(eq(paddleConnections.workspaceId, workspaceId))
    .orderBy(asc(paddleConnections.createdAt), asc(paddleConnections.id));
  const repositories = await db
    .select({
      id: resources.id,
      connectionId: resources.connectionId,
      provider: resources.provider,
      externalId: resources.externalId,
      name: resources.nameSnapshot,
      private: resources.private,
      archived: resources.archived,
      selection: resources.selection,
      discoveredAt: resources.discoveredAt,
    })
    .from(resources)
    .where(eq(resources.workspaceId, workspaceId))
    .orderBy(asc(resources.nameSnapshot), asc(resources.id));
  const offerRows = await db
    .select({
      id: offers.id,
      name: offers.name,
      status: offers.status,
      gracePeriodDays: offers.gracePeriodDays,
      version: offers.version,
      createdAt: offers.createdAt,
      updatedAt: offers.updatedAt,
    })
    .from(offers)
    .where(eq(offers.workspaceId, workspaceId))
    .orderBy(asc(offers.createdAt), asc(offers.id));
  const items = await db
    .select({
      offerId: offerItems.offerId,
      source: offerItems.source,
      externalItemId: offerItems.externalItemId,
    })
    .from(offerItems)
    .where(eq(offerItems.workspaceId, workspaceId))
    .orderBy(asc(offerItems.offerId), asc(offerItems.externalItemId));
  const accesses = await db
    .select({
      offerId: offerAccesses.offerId,
      resourceId: offerAccesses.resourceId,
      accessLevel: offerAccesses.accessLevel,
    })
    .from(offerAccesses)
    .where(eq(offerAccesses.workspaceId, workspaceId))
    .orderBy(asc(offerAccesses.offerId), asc(offerAccesses.resourceId));
  const versions = await db
    .select({
      offerId: offerVersions.offerId,
      version: offerVersions.version,
      snapshot: offerVersions.snapshot,
      createdAt: offerVersions.createdAt,
      createdByUserId: offerVersions.createdByUserId,
    })
    .from(offerVersions)
    .where(eq(offerVersions.workspaceId, workspaceId))
    .orderBy(asc(offerVersions.offerId), asc(offerVersions.version));
  const prices = await db
    .select({
      connectionId: paddlePrices.connectionId,
      priceId: paddlePrices.priceId,
      productId: paddlePrices.productId,
      productName: paddlePrices.productName,
      description: paddlePrices.description,
      billingInterval: paddlePrices.billingInterval,
      billingFrequency: paddlePrices.billingFrequency,
      unitAmount: paddlePrices.unitAmount,
      currency: paddlePrices.currency,
      status: paddlePrices.status,
    })
    .from(paddlePrices)
    .where(eq(paddlePrices.workspaceId, workspaceId))
    .orderBy(asc(paddlePrices.priceId));
  const subjectRows = await db
    .select({
      id: subjects.id,
      provider: subjects.provider,
      type: subjects.type,
      externalSubjectId: subjects.externalSubjectId,
      login: subjects.loginSnapshot,
      createdAt: subjects.createdAt,
    })
    .from(subjects)
    .where(eq(subjects.workspaceId, workspaceId))
    .orderBy(asc(subjects.createdAt), asc(subjects.id));
  const customerRows = await db
    .select({
      id: customers.id,
      source: customers.source,
      externalCustomerId: customers.externalCustomerId,
      subjectId: customers.subjectId,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(eq(customers.workspaceId, workspaceId))
    .orderBy(asc(customers.createdAt), asc(customers.id));
  const subscriptionRows = await db
    .select({
      id: subscriptions.id,
      source: subscriptions.source,
      externalSubscriptionId: subscriptions.externalSubscriptionId,
      customerId: subscriptions.customerId,
      state: subscriptions.state,
      providerState: subscriptions.providerState,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAt: subscriptions.cancelAt,
      endedAt: subscriptions.endedAt,
      pastDueSince: subscriptions.pastDueSince,
      sourceUpdatedAt: subscriptions.sourceUpdatedAt,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
  const subscriptionItemRows = await db
    .select({
      subscriptionId: subscriptionItems.subscriptionId,
      externalItemId: subscriptionItems.externalItemId,
    })
    .from(subscriptionItems)
    .where(eq(subscriptionItems.workspaceId, workspaceId))
    .orderBy(asc(subscriptionItems.subscriptionId), asc(subscriptionItems.externalItemId));
  const entitlementRows = await db
    .select({
      id: entitlements.id,
      subjectId: entitlements.subjectId,
      resourceId: entitlements.resourceId,
      accessLevel: entitlements.accessLevel,
      sourceType: entitlements.sourceType,
      subscriptionId: entitlements.subscriptionId,
      manualAccessId: entitlements.manualAccessId,
      offerId: entitlements.offerId,
      offerVersion: entitlements.offerVersion,
      policyVersion: entitlements.policyVersion,
      state: entitlements.state,
      validFrom: entitlements.validFrom,
      validUntil: entitlements.validUntil,
      reason: entitlements.decisionReason,
      endedAt: entitlements.endedAt,
    })
    .from(entitlements)
    .where(eq(entitlements.workspaceId, workspaceId))
    .orderBy(asc(entitlements.createdAt), asc(entitlements.id));
  const manualAccessRows = await db
    .select({
      id: manualAccesses.id,
      offerId: manualAccesses.offerId,
      subjectId: manualAccesses.subjectId,
      endsAt: manualAccesses.endsAt,
      note: manualAccesses.note,
      revokedAt: manualAccesses.revokedAt,
      revokeCause: manualAccesses.revokeCause,
      createdAt: manualAccesses.createdAt,
    })
    .from(manualAccesses)
    .where(eq(manualAccesses.workspaceId, workspaceId))
    .orderBy(asc(manualAccesses.createdAt), asc(manualAccesses.id));
  const grantRows = await db
    .select({
      id: grants.id,
      connectionId: grants.connectionId,
      subjectId: grants.subjectId,
      resourceId: grants.resourceId,
      accessLevel: grants.accessLevel,
      state: grants.state,
      managed: grants.managed,
      indirect: grants.indirect,
      entitlementId: grants.entitlementId,
      observedAt: grants.observedAt,
      lastErrorCode: grants.lastErrorCode,
    })
    .from(grants)
    .where(eq(grants.workspaceId, workspaceId))
    .orderBy(asc(grants.createdAt), asc(grants.id));
  const audit = await db
    .select({
      id: auditEvents.id,
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      reason: auditEvents.reason,
      correlationId: auditEvents.correlationId,
      occurredAt: auditEvents.occurredAt,
      details: auditEvents.details,
    })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(asc(auditEvents.occurredAt), sql`rowid`);
  return {
    workspace: workspace ?? null,
    members,
    githubConnections,
    paddleConnections: paddle,
    repositories,
    offers: offerRows,
    offerItems: items,
    offerAccesses: accesses,
    offerVersions: versions,
    paddlePrices: prices,
    subjects: subjectRows,
    customers: customerRows,
    subscriptions: subscriptionRows,
    subscriptionItems: subscriptionItemRows,
    manualAccesses: manualAccessRows,
    entitlements: entitlementRows,
    grants: grantRows,
    auditEvents: audit,
  };
}

export type WorkspaceExportRows = Awaited<ReturnType<typeof readWorkspaceExport>>;
