import { env } from "cloudflare:workers";
import { listAuditEventsByCorrelationId } from "@sharerepo/db";
import { EXPORT_RATE_LIMIT } from "@sharerepo/domain";
import { ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { createSecretCanaries, expectNoCanaryLeak } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  exportWorkspace,
  requestClaim,
  requestWorkspaceDeletion,
  startCheckout,
} from "../src/index.ts";
import { memberOf, offer, shop, subscribe } from "./support/commerce.ts";
import { clock, serviceContext, signedUpUser } from "./support/context.ts";
import { buyer, buyerIp, paddleCustomer, paddleShop } from "./support/paddle.ts";

// The workspace export (decision 0015, threat O6).

/** Every value of the given columns in the workspace's rows: none may reach the export. */
async function storedSecrets(workspaceId: string): Promise<string[]> {
  const columns: readonly [string, string][] = [
    ["paddle_connections", "api_key_envelope"],
    ["paddle_connections", "webhook_secret_envelope"],
    ["claim_requests", "email_hash"],
    ["claim_requests", "email_envelope"],
    ["claim_tokens", "token_hash"],
    ["checkout_claims", "checkout_url"],
    ["connection_intents", "token_hash"],
  ];
  const values: string[] = [];
  for (const [table, column] of columns) {
    const { results } = await env.DB.prepare(
      `SELECT ${column} AS value FROM ${table} WHERE workspace_id = ? AND ${column} IS NOT NULL`,
    )
      .bind(workspaceId)
      .all<{ value: string }>();
    values.push(...results.map((row) => row.value));
  }
  return values;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

describe("export/contains-no-secrets", { timeout: 60_000 }, () => {
  it("contains the workspace's records and never a credential, hash, claim or email", async () => {
    const s = await paddleShop();
    // A buyer asked for claim links by email, and another started a checkout.
    const customer = paddleCustomer(s);
    const asking = await buyer();
    const requested = await requestClaim(
      serviceContext(),
      { workspaceSlug: s.slug, email: customer.email, user: asking, ip: buyerIp() },
      s.deps,
    );
    expect(requested.status).toBe("requested");
    const checkingOut = await buyer();
    await startCheckout(
      serviceContext(),
      { offerId: s.offer.id, priceId: s.price.id, user: checkingOut, ip: buyerIp() },
      s.deps,
    );
    // A canary in a column the export never reads.
    const canaries = createSecretCanaries(["checkoutUrl"]);
    await env.DB.prepare("UPDATE checkout_claims SET checkout_url = ? WHERE workspace_id = ?")
      .bind(`https://pay.test/${canaries.checkoutUrl}`, s.workspaceId)
      .run();
    const secrets = await storedSecrets(s.workspaceId);
    expect(secrets.length).toBeGreaterThanOrEqual(5);

    const ctx = serviceContext();
    const result = await exportWorkspace(ctx, s, s.slug);
    if (!result.ok) throw new Error(result.reason);
    const { document } = result;
    expect(document).toMatchObject({
      formatVersion: 1,
      exportedAt: clock.now(),
      workspace: { id: s.workspaceId, slug: s.slug, status: "active" },
      members: [{ userId: s.userId, role: "owner" }],
      paddleConnections: [{ id: s.connectionId, status: "active" }],
      offers: [{ id: s.offer.id }],
      paddlePrices: [{ priceId: s.price.id }],
    });
    expect(document.repositories).toHaveLength(s.resources.length);
    expect(document.auditEvents.map((e) => e.action)).toContain("checkout.started");
    expect(result.filename).toBe(
      `sharerepo-${s.slug}-${new Date(clock.now()).toISOString().slice(0, 10)}.json`,
    );

    const text = JSON.stringify(document);
    expectNoCanaryLeak(document, canaries);
    expectNoCanaryLeak(text, secrets);
    expect(text).not.toMatch(EMAIL);
    expect(text).not.toContain(customer.email);
    for (const key of ["envelope", "Envelope", "hash", "Hash", "token", "email", "checkoutUrl"]) {
      expect(text).not.toContain(`"${key}`);
    }

    const events = await listAuditEventsByCorrelationId(serviceContext().db, ctx.correlationId);
    expect(events.map((e) => [e.action, e.details])).toEqual([
      ["workspace.exported", { formatVersion: 1 }],
    ]);
  });

  it("is limited to 5 an hour per workspace", async () => {
    const s = await shop();
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      expect((await exportWorkspace(serviceContext(), s, s.slug)).ok).toBe(true);
    }
    const refused = await exportWorkspace(serviceContext(), s, s.slug);
    const hour = EXPORT_RATE_LIMIT.windowMs;
    expect(refused).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAt: clock.now() - (clock.now() % hour) + hour,
    });
    clock.advance(hour);
    expect((await exportWorkspace(serviceContext(), s, s.slug)).ok).toBe(true);
  });

  it("is the owner's, and still available while the workspace is being deleted", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    await subscribe(s, { items: ["sim_pro"] });
    const member = await memberOf(s);
    await expect(exportWorkspace(serviceContext(), member, s.slug)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      exportWorkspace(serviceContext(), await signedUpUser(), s.slug),
    ).rejects.toBeInstanceOf(NotFoundError);
    await requestWorkspaceDeletion(serviceContext(), s, s.slug, { confirmation: s.slug }, null);
    const result = await exportWorkspace(serviceContext(), s, s.slug);
    expect(result.ok && result.document.workspace?.status).toBe("deleting");
  });
});
