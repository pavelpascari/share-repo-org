import { env } from "cloudflare:workers";
import { createDb, enqueueOutbox } from "@sharerepo/db";
import { WORKSPACE_DELETION_DELAY_MS } from "@sharerepo/domain";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { type CrashWhen, crashingD1, InjectedCrash } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  confirmClaim,
  connectPaddle,
  deleteAccount,
  evaluateManualAccess,
  grantManualAccess,
  paddleEntitlementSource,
  processPaddleEvent,
  purgeWorkspace,
  RECONCILE_LEASE_MS,
  reconcileResource,
  recordJobFailure,
  refreshSubscription,
  requestWorkspaceDeletion,
  retryFailure,
  rotatePaddleWebhookSecret,
  type ServiceContext,
  startCheckout,
  syncPaddleCatalog,
} from "../src/index.ts";
import {
  DAY,
  drain,
  githubUser,
  offer,
  refresh,
  type Shop,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, serviceContext, signedUpUser } from "./support/context.ts";
import {
  buyerIp,
  claimLinkToken,
  commerceDeps,
  connectionOf,
  deliverSubscription,
  directSubscription,
  drainPaddle,
  PaddleAccounts,
  type PaddleShop,
  paddleCustomer,
  paddleShop,
  post,
  settingOf,
} from "./support/paddle.ts";

// crash/every-batch-boundary-converges (phase-6 plan § Fault injection): each multi-write
// operation runs once cleanly to count its writes, then once per write boundary with that write
// failing before or after it commits, as a Worker crash would. The queue or the user then runs it
// again, and the final state and audit trail must match the clean run's.

/** A world one operation acts on, built fresh for each run. */
interface Fixture {
  readonly workspaceId: string;
  /** Strings unique to this fixture (slug, logins, names), replaced before comparing. */
  readonly tokens: readonly string[];
  /** IDs whose account-scoped audit events belong to the trail (users, the workspace). */
  readonly accountTargets: readonly string[];
  /** Provider state the operation changes (the fake GitHub App's or Paddle's), as plain data. */
  readonly provider: () => unknown;
  /** Rows outside the workspace's tables that the operation changes (an account's, a purge's). */
  readonly outside?: () => Promise<unknown>;
}

interface Case<F extends Fixture> {
  readonly name: string;
  setup(): Promise<F>;
  /** One attempt, over `ctx`. */
  run(fixture: F, ctx: ServiceContext): Promise<unknown>;
  /**
   * Writes whose failure the operation absorbs by design, reporting a partial success the page
   * then offers to complete (Paddle connect's catalog import). Any other crash must surface.
   */
  tolerates?(write: number): boolean;
  /** Follow-up work the queue runs after the operation, clean or recovered (default: none). */
  settle?(fixture: F): Promise<unknown>;
  /** What the queue or the user does after a crash; defaults to `run` once. */
  rerun?(fixture: F, ctx: () => ServiceContext): Promise<unknown>;
  /**
   * History a recovery may add on top of the clean run's, by table: an append-only row recording
   * what the crashed attempt did and how the next run settled it (a mutation in doubt, resolved).
   * Every row of the clean run must still be there.
   */
  recovery?: Readonly<Record<string, Recovery>>;
}

interface Recovery {
  /** A row the recovery may add. */
  readonly added: (row: Record<string, unknown>) => boolean;
  /** A clean-run row the recovery may record differently (and so lack). */
  readonly replaced?: (row: Record<string, unknown>) => boolean;
}

/**
 * The crashed-and-rerun snapshot equals the clean one, except that a `recovery` table may hold
 * extra rows its predicate accepts (and must hold every clean row).
 */
function expectConverged(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  recovery: NonNullable<Case<Fixture>["recovery"]>,
  message: string,
) {
  const strictActual = { ...actual };
  const strictExpected = { ...expected };
  for (const [table, { added, replaced }] of Object.entries(recovery)) {
    const rows = [...((actual[table] as string[] | undefined) ?? [])];
    for (const row of (expected[table] as string[] | undefined) ?? []) {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
      else {
        const parsed = JSON.parse(row) as Record<string, unknown>;
        expect(replaced?.(parsed) ?? false, `${message}: ${table} lost ${row}`).toBe(true);
      }
    }
    for (const extra of rows) {
      const parsed = JSON.parse(extra) as Record<string, unknown>;
      expect(added(parsed), `${message}: ${table} gained ${extra}`).toBe(true);
    }
    delete strictActual[table];
    delete strictExpected[table];
  }
  expect(strictActual, message).toEqual(strictExpected);
}

const contextOver = (binding: D1Database): ServiceContext => ({
  ...serviceContext(),
  db: createDb(binding),
});

/** Columns whose values differ between equivalent runs: generated IDs, instants, leases. */
const VOLATILE_COLUMN =
  /^(id|.*_id|.*_ids|.*_at|.*_hash|.*_digest|.*_token|lease_until|correlation_id)$/;
/** Sealed credentials: random IVs differ between runs; only their key ID is compared. */
const ENVELOPE_COLUMN = /_envelope$/;
/** An ID from the test contexts' SequentialIds (`<10 hex>-<6 digits>`), inside any string. */
const GENERATED_ID = /[0-9a-f]{10}-\d{6}/g;
/** JSON keys whose values differ between equivalent runs. */
const VOLATILE_KEY = /^(id|.*Id|.*Ids|.*At|.*Until)$/;

function normalize(value: unknown, tokens: readonly string[]): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return normalize(JSON.parse(trimmed) as unknown, tokens);
      } catch {
        // Not JSON: compared as text.
      }
    }
    return tokens
      .reduce((text, token, i) => text.replaceAll(token, `<${i}>`), value)
      .replace(GENERATED_ID, "<generated>");
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, tokens));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_KEY.test(key))
        .map(([key, item]) => [key, normalize(item, tokens)]),
    );
  }
  return value;
}

let workspaceTables: string[] | undefined;

/** Every table with a `workspace_id` column. */
async function tablesWithWorkspace(): Promise<string[]> {
  if (workspaceTables !== undefined) return workspaceTables;
  const { results } = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string; sql: string }>();
  // D1 refuses pragma_table_info in a query; the CREATE statement names the columns.
  workspaceTables = results
    .filter((row) => /[`"]workspace_id[`"]\s/.test(row.sql))
    .map((row) => row.name);
  return workspaceTables;
}

/**
 * The fixture's state as comparable data: every row of every workspace-scoped table (Paddle's
 * received events by their connection), the account-scoped audit events about its targets, and
 * the provider's state. Volatile columns and fixture-unique strings are normalized, and each
 * table's rows are sorted, so two equivalent runs compare equal.
 */
async function snapshot(fixture: Fixture): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const rowsOf = async (table: string, sql: string, ...params: unknown[]) => {
    const { results } = await env.DB.prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>();
    out[table] = results
      .map((row) =>
        normalize(
          Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => !VOLATILE_COLUMN.test(key))
              .map(([key, value]) => [
                key,
                ENVELOPE_COLUMN.test(key) && typeof value === "string"
                  ? `<sealed:${(JSON.parse(value) as { kid?: string }).kid}>`
                  : value,
              ]),
          ),
          fixture.tokens,
        ),
      )
      .map((row) => JSON.stringify(row))
      .sort();
  };
  for (const table of await tablesWithWorkspace()) {
    await rowsOf(table, `SELECT * FROM "${table}" WHERE workspace_id = ?`, fixture.workspaceId);
  }
  await rowsOf(
    "external_events",
    `SELECT * FROM external_events WHERE connection_id IN
       (SELECT id FROM paddle_connections WHERE workspace_id = ?)`,
    fixture.workspaceId,
  );
  const targets = fixture.accountTargets;
  await rowsOf(
    "account_audit_events",
    `SELECT * FROM audit_events WHERE scope = 'account'
       AND target_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(targets),
  );
  out.provider = normalize(fixture.provider(), fixture.tokens);
  if (fixture.outside !== undefined)
    out.outside = normalize(await fixture.outside(), fixture.tokens);
  return out;
}

/**
 * Runs the matrix for one operation: a clean run counts its writes and gives the expected
 * snapshot; then, for each write and each side of it, a run crashes there and is run again.
 */
async function expectEveryBoundaryConverges<F extends Fixture>(c: Case<F>): Promise<number> {
  // Every run starts at the same instant, so fixtures' timestamps compare equal.
  const start = clock.now();
  const clean = await c.setup();
  const counting = crashingD1(env.DB, null);
  await c.run(clean, contextOver(counting.binding));
  const writes = counting.writes;
  await c.settle?.(clean);
  expect(writes, `${c.name}: the clean run writes`).toBeGreaterThan(0);
  const expected = await snapshot(clean);

  for (let at = 1; at <= writes; at += 1) {
    for (const when of ["before", "after"] as CrashWhen[]) {
      clock.set(start);
      const fixture = await c.setup();
      const crashing = crashingD1(env.DB, { at, when });
      const error = await c.run(fixture, contextOver(crashing.binding)).then(
        () => null,
        (e: unknown) => e,
      );
      // The crash must surface; an operation that swallowed it would report success falsely.
      if (error !== null || c.tolerates?.(at) !== true) {
        expect(crashOf(error), `${c.name}: write ${at} ${when}`).toBeInstanceOf(InjectedCrash);
      }
      await (c.rerun ?? ((f, ctx) => c.run(f, ctx())))(fixture, () => serviceContext());
      await c.settle?.(fixture);
      const actual = await snapshot(fixture);
      expectConverged(actual, expected, c.recovery ?? {}, `${c.name}: crash ${when} write ${at}`);
    }
  }
  return writes;
}

const TIMEOUT = 120_000;

/** The injected crash, possibly wrapped (Drizzle wraps a failed single statement's error). */
function crashOf(error: unknown): unknown {
  for (let e = error; e instanceof Error; e = e.cause) if (e instanceof InjectedCrash) return e;
  return error;
}

// --- Cases ----------------------------------------------------------------------------------

interface ShopFixture extends Fixture {
  readonly s: Shop;
  readonly subscriptionId: string;
}

async function shopFixture(s: Shop, subscriptionId: string, login: string): Promise<ShopFixture> {
  const repo = s.resources[0]?.nameSnapshot as string;
  const owner = await env.DB.prepare(
    "SELECT account_login_snapshot AS login FROM connections WHERE workspace_id = ?",
  )
    .bind(s.workspaceId)
    .first<{ login: string }>();
  return {
    s,
    subscriptionId,
    workspaceId: s.workspaceId,
    // Longest first, so a token inside another is replaced after it.
    tokens: [s.slug, login, repo, owner?.login ?? "", s.installationId]
      .filter((t) => t !== "")
      .sort((a, b) => b.length - a.length),
    accountTargets: [s.workspaceId, s.userId],
    provider: () => s.github.repositoryAccess(repo),
  };
}

/** A shop selling its repository, with a subscriber whose refresh is still queued. */
async function soldShop(): Promise<ShopFixture> {
  const s = await shop(1, createFakeGitHubApp({ clock }));
  await offer(s, { items: ["sim_pro"] });
  // The offer's recompute first, so the fixture does not depend on the order of the two jobs.
  await drain(s.workspaceId);
  const sub = await subscribe(s, { items: ["sim_pro"] });
  return shopFixture(s, sub.id, sub.login);
}

const reconcileRef = (f: ShopFixture) => ({
  workspaceId: f.workspaceId,
  resourceId: f.s.resources[0]?.id as string,
});

/**
 * Reconciles as the sweep would after a crash: a crashed run's lease must expire first, and an
 * intent left `provisioning` or `revoking` settles only once its observation grace has passed, at
 * the repository's next scheduled check.
 */
async function reconcileUntilSettled(f: ShopFixture, ctx: () => ServiceContext) {
  for (let run = 0; run < 6; run += 1) {
    if ((await reconcileResource(ctx(), reconcileRef(f), f.s.github)) === "busy") {
      clock.advance(RECONCILE_LEASE_MS);
      continue;
    }
    const state = await env.DB.prepare(
      `SELECT next_reconcile_at AS next,
         (SELECT count(*) FROM grants WHERE workspace_id = r.workspace_id
            AND state IN ('provisioning', 'revoking')) AS unsettled
       FROM resources r WHERE workspace_id = ? AND id = ?`,
    )
      .bind(f.workspaceId, reconcileRef(f).resourceId)
      .first<{ next: number | null; unsettled: number }>();
    if (state === null || state.unsettled === 0) return;
    clock.set(Math.max(state.next ?? 0, clock.now() + 1));
  }
  throw new Error("reconcile did not settle");
}

describe("crash/every-batch-boundary-converges", { timeout: TIMEOUT }, () => {
  it("a subscription refresh", async () => {
    await expectEveryBoundaryConverges({
      name: "refresh",
      setup: soldShop,
      run: (f, ctx) => refresh(f.s, f.subscriptionId, ctx),
    });
  });

  it("a reconcile run", async () => {
    const writes = await expectEveryBoundaryConverges({
      name: "reconcile",
      setup: async () => {
        const f = await soldShop();
        await drain(f.workspaceId);
        return f;
      },
      run: (f, ctx) => reconcileResource(ctx, reconcileRef(f), f.s.github),
      rerun: reconcileUntilSettled,
      // A crash after an intent was written leaves a mutation in doubt: the next run observes
      // that it never landed, resolves it, and sends it again. That history stays.
      // A crash after the call went out but before its result was stored: the next run observes
      // the invitation and records the mutation as resolved rather than succeeded.
      recovery: {
        audit_events: {
          added: (row) =>
            [
              "provider.mutation_attempted",
              "provider.mutation_resolved",
              "grant.observed",
            ].includes(row.action as string),
          replaced: (row) => row.action === "provider.mutation_succeeded",
        },
        provider_mutations: {
          added: (row) => row.status === "resolved",
          replaced: (row) => row.status === "succeeded",
        },
      },
    });
    expect(writes).toBeGreaterThan(1);
  });

  it("a failure retry", async () => {
    await expectEveryBoundaryConverges({
      name: "failure retry",
      setup: async () => {
        const f = await soldShop();
        const outboxId = `obx-${crypto.randomUUID()}`;
        await enqueueOutbox(createDb(env.DB), {
          id: outboxId,
          kind: "resync_connection",
          subjectId: f.s.connection.id,
          createdAt: clock.now(),
          availableAt: clock.now(),
          workspaceId: f.workspaceId,
        });
        await recordJobFailure(serviceContext(), { outboxId, errorCode: "rejected" });
        return { ...f, outboxId };
      },
      run: (f, ctx) => retryFailure(ctx, f.s, f.s.slug, f.outboxId),
      // The owner presses Retry again; once retried, the failure is no longer open.
      rerun: async (f, ctx) => {
        await retryFailure(ctx(), f.s, f.s.slug, f.outboxId).catch(() => undefined);
      },
    });
  });

  it("Paddle connect", async () => {
    await expectEveryBoundaryConverges({
      name: "paddle connect",
      setup: async () => {
        const s = await shop(1, createFakeGitHubApp({ clock }));
        const accounts = new PaddleAccounts();
        const { fake, key } = accounts.seller();
        const base = await shopFixture(s, "", "");
        return {
          ...base,
          key,
          deps: commerceDeps(accounts),
          tokens: [...base.tokens, key],
          provider: () => fake.notificationSettings(),
        };
      },
      run: (f, ctx) =>
        connectPaddle(ctx, f.s, f.s.slug, { apiKey: f.key, apiKeyExpiresOn: null }, f.deps),
      // Importing the catalog (after the connection is stored) may fail without failing the
      // connect: the page then offers "Refresh catalog".
      tolerates: (write) => write > 1,
      // Refreshing a catalog that was imported after all is audited again, as any refresh is.
      recovery: {
        audit_events: { added: (row) => row.action === "paddle.catalog_synced" },
      },
      // The owner submits the key again; once connected, the billing page offers "Refresh
      // catalog" for a catalog the crashed attempt did not import.
      rerun: async (f, ctx) => {
        const connected = await connectPaddle(
          ctx(),
          f.s,
          f.s.slug,
          { apiKey: f.key, apiKeyExpiresOn: null },
          f.deps,
        );
        if (!connected.ok && connected.error.reason === "already_connected") {
          await syncPaddleCatalog(ctx(), f.s, f.s.slug, f.deps);
        }
      },
    });
  });

  it("Paddle webhook secret rotation", async () => {
    await expectEveryBoundaryConverges({
      name: "rotation",
      setup: async () => {
        const f = await paddleFixture();
        return { ...f, destinationId: (await connectionOf(f.p)).destinationId };
      },
      run: (f, ctx) => rotatePaddleWebhookSecret(ctx, f.p, f.p.slug, f.p.deps),
      // The owner presses "Rotate webhook secret" again unless the rotation already completed
      // (the billing page then shows the new destination; pressing again would rotate anew).
      rerun: async (f, ctx) => {
        const { destinationId } = await connectionOf(f.p);
        if (destinationId === f.destinationId) {
          await rotatePaddleWebhookSecret(ctx(), f.p, f.p.slug, f.p.deps);
        }
      },
    });
  });

  it("a claim by email (path 2): confirming the link", async () => {
    await expectEveryBoundaryConverges({
      name: "claim path 2",
      setup: async () => {
        const f = await paddleFixture();
        const customer = paddleCustomer(f.p);
        await deliverSubscription(
          f.p,
          "subscription.created",
          directSubscription(f.p, customer.id).id,
        );
        const user = await signedUpUser();
        const token = await claimLinkToken(f.p, user, customer.email);
        return {
          ...f,
          user,
          token,
          tokens: [user.profile.username, ...f.tokens],
          accountTargets: [...f.accountTargets, user.userId],
        };
      },
      run: (f, ctx) => confirmClaim(ctx, { token: f.token, user: f.user }),
    });
  });

  it("a checkout claim (path 1): the refresh that links the buyer", async () => {
    await expectEveryBoundaryConverges({
      name: "claim path 1",
      setup: async () => {
        const f = await paddleFixture();
        const user = await signedUpUser();
        const started = await startCheckout(
          serviceContext(),
          { offerId: f.p.offer.id, priceId: f.p.price.id, user, ip: buyerIp() },
          f.p.deps,
        );
        if (!started.ok) throw new Error(started.reason);
        const transactionId = new URL(started.checkoutUrl).searchParams.get("_ptxn") as string;
        const customer = paddleCustomer(f.p);
        const subscription = f.p.paddle.completeCheckout(transactionId, {
          customerId: customer.id,
        });
        // The webhook is processed; its refresh, which links, is left queued.
        const delivery = await f.p.paddle.emitSubscriptionEvent(
          await settingOf(f.p),
          "subscription.created",
          subscription.id,
        );
        const ingested = await post(f.p, delivery);
        if (ingested.status !== "accepted") throw new Error(ingested.status);
        await processPaddleEvent(serviceContext(), ingested.eventId);
        return {
          ...f,
          subscriptionId: subscription.id,
          tokens: [user.profile.username, ...f.tokens],
          accountTargets: [...f.accountTargets, user.userId],
        };
      },
      run: (f, ctx) =>
        refreshSubscription(
          ctx,
          {
            workspaceId: f.workspaceId,
            source: "paddle",
            externalSubscriptionId: f.subscriptionId,
          },
          paddleEntitlementSource(ctx, f.p.deps),
        ),
      // The link queues another refresh, which creates the entitlement: compare after it.
      settle: (f) => drainPaddle(f.p),
    });
  });

  it("a workspace purge", async () => {
    await expectEveryBoundaryConverges({
      name: "purge",
      setup: async () => {
        const f = await soldShop();
        await drain(f.workspaceId);
        await requestWorkspaceDeletion(
          serviceContext(),
          f.s,
          f.s.slug,
          { confirmation: f.s.slug },
          null,
        );
        await drain(f.workspaceId);
        clock.advance(WORKSPACE_DELETION_DELAY_MS);
        return {
          ...f,
          outside: async () =>
            (
              await env.DB.prepare("SELECT key, value FROM system_state WHERE key IN (?, ?)")
                .bind(`purge_progress:${f.workspaceId}`, `purge_blocked:${f.workspaceId}`)
                .all()
            ).results,
        };
      },
      // The outbox runs the purge's continuations until it finishes.
      run: async (f, ctx) => {
        for (let run = 0; run < 50; run += 1) {
          if ((await purgeWorkspace(ctx, f.workspaceId, { batchesPerRun: 2 })) !== "continuing") {
            return;
          }
        }
        throw new Error("purge did not finish");
      },
      rerun: async (f, ctx) => {
        for (let run = 0; run < 50; run += 1) {
          if ((await purgeWorkspace(ctx(), f.workspaceId)) !== "continuing") return;
        }
        throw new Error("purge did not finish");
      },
    });
  });

  // Decision 0016: a grant writes the account's subject, the rate-limit counter, then the access
  // with its entitlements in one batch. A resubmitted form finds the access granted.
  it("a manual access grant", async () => {
    await expectEveryBoundaryConverges({
      name: "manual grant",
      setup: async () => {
        const s = await shop(1, createFakeGitHubApp({ clock }));
        const sold = await offer(s, { items: ["sim_pro"] });
        await drain(s.workspaceId);
        const user = githubUser(s);
        return { ...(await shopFixture(s, "", user.login)), offerId: sold.id, login: user.login };
      },
      run: (f, ctx) =>
        grantManualAccess(
          ctx,
          f.s,
          f.s.slug,
          {
            offerId: f.offerId,
            githubLogin: f.login,
            endsAt: clock.now() + 30 * DAY,
            note: "trial",
          },
          { github: f.s.github },
        ),
    });
  });

  it("a manual access's end date, at the sweep", async () => {
    await expectEveryBoundaryConverges({
      name: "manual expiry",
      setup: async () => {
        const s = await shop(1, createFakeGitHubApp({ clock }));
        const sold = await offer(s, { items: ["sim_pro"] });
        await drain(s.workspaceId);
        const user = githubUser(s);
        const granted = await grantManualAccess(
          serviceContext(),
          s,
          s.slug,
          { offerId: sold.id, githubLogin: user.login, endsAt: clock.now() + DAY, note: "" },
          { github: s.github },
        );
        if (!granted.ok) throw new Error(granted.error);
        return {
          ...(await shopFixture(s, "", user.login)),
          manualAccessId: granted.manualAccessId,
        };
      },
      run: async (f, ctx) => {
        const at = { ...ctx, clock: { now: () => clock.now() + 2 * DAY } };
        return evaluateManualAccess(at, {
          workspaceId: f.workspaceId,
          manualAccessId: f.manualAccessId,
        });
      },
    });
  });

  it("an account deletion", async () => {
    await expectEveryBoundaryConverges({
      name: "account deletion",
      setup: async () => {
        const f = await paddleFixture();
        const customer = paddleCustomer(f.p);
        await deliverSubscription(
          f.p,
          "subscription.created",
          directSubscription(f.p, customer.id).id,
        );
        const user = await signedUpUser();
        const token = await claimLinkToken(f.p, user, customer.email);
        const confirmed = await confirmClaim(serviceContext(), { token, user });
        if (!confirmed.ok) throw new Error("claim not confirmed");
        await drainPaddle(f.p);
        const login = user.profile.username;
        return {
          ...f,
          user,
          login,
          tokens: [login, ...f.tokens],
          accountTargets: [...f.accountTargets, user.userId],
          outside: async () => ({
            users: await countWhere("users", "id", user.userId),
            identities: await countWhere("external_identities", "user_id", user.userId),
            memberships: await countWhere("workspace_memberships", "user_id", user.userId),
            sessions: await countWhere("auth_sessions", "user_id", user.userId),
          }),
        };
      },
      run: (f, ctx) => deleteAccount(ctx, f.user, { confirmation: f.login }),
    });
  });
});

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${table}" WHERE "${column}" = ?`)
    .bind(value)
    .first<{ n: number }>();
  return Number(row?.n);
}

interface PaddleFixture extends ShopFixture {
  readonly p: PaddleShop;
}

/** A Paddle shop (connected, with an offer selling its price) as a fixture. */
async function paddleFixture(): Promise<PaddleFixture> {
  const p = await paddleShop();
  await drain(p.workspaceId);
  const base = await shopFixture(p, "", "");
  return {
    ...base,
    p,
    tokens: [...base.tokens, p.key, p.connectionId].sort((a, b) => b.length - a.length),
    provider: () => p.paddle.notificationSettings(),
  };
}
