import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type CommerceDeps,
  completeGitHubConnection,
  decodeClaimRequestKey,
  resyncConnection,
  sendClaimEmail,
  startGitHubConnection,
} from "@sharerepo/application";
import { getPaddleConnection, listResourcesForConnection } from "@sharerepo/db";
import { randomIds, systemClock } from "@sharerepo/domain";
import { PaddleApiError, type PaddlePort } from "@sharerepo/integrations";
import {
  createFakeGitHubApp,
  createFakeMail,
  createFakePaddle,
  type FakePaddle,
  signPaddleWebhook,
  signWebhook,
} from "@sharerepo/integrations/testing";
import { createLogger } from "@sharerepo/platform";
import {
  captureLogs,
  createSecretCanaries,
  emailShapes,
  encodedNeedles,
  expectNoCanaryLeak,
  expectNoSecretsInStoredRows,
  type LogCapture,
  type StoredValue,
} from "@sharerepo/testing";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../app/auth/auth.ts";
import { commerceDepsFromEnv, providerOverrides } from "../app/commerce.server.ts";
import { cloudflareContext } from "../app/context.ts";
import * as buy from "../app/routes/buy.$offerId.tsx";
import * as claimRequest from "../app/routes/c.$slug.claim.tsx";
import * as claim from "../app/routes/claim.$token.tsx";
import * as me from "../app/routes/me.access.tsx";
import * as account from "../app/routes/me.tsx";
import * as ops from "../app/routes/ops.tsx";
import * as opsWorkspace from "../app/routes/ops.w.$slug.tsx";
import * as access from "../app/routes/w.$slug.access.tsx";
import * as billing from "../app/routes/w.$slug.billing.tsx";
import * as customers from "../app/routes/w.$slug.customers.tsx";
import * as exporting from "../app/routes/w.$slug.export.ts";
import * as offers from "../app/routes/w.$slug.offers.tsx";
import * as repositories from "../app/routes/w.$slug.repositories.tsx";
import * as settings from "../app/routes/w.$slug.settings.tsx";
import * as simulator from "../app/routes/w.$slug.simulator.tsx";
import * as layout from "../app/routes/w.$slug.tsx";
import * as newWorkspace from "../app/routes/workspaces.new.tsx";
import { parseWebEnv } from "../workers/env.ts";
import { createFetchHandler } from "../workers/handler.ts";
import { fakeAccount } from "./support/fake-github.ts";
import { drain } from "./support/paddle.ts";
import { cookiesOf, db, github as oauth, canaries as signInCanaries } from "./support/sign-in.ts";

// security/no-secrets-in-stored-rows-or-logs (Phase 6 acceptance; threats O6 and O18), at the
// web Worker: sign-in, the owner's, buyer's and operator's pages, and both webhooks through the
// request handler, with a canary for every secret the web Worker holds or receives. Then every
// text value of every table and every log line (console and the request loggers) is scanned for
// the canaries (as written, hex or base64) and for email shapes.

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

const canaries = createSecretCanaries([
  "betterAuthSecret",
  "githubClientSecret",
  "githubWebhookSecret",
  "githubWebhookSecretPrevious",
  "claimSigningKey",
  "githubPayload",
  "providerError",
  "renderError",
]);
const nonce = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
// An AES-256 master key must be 32 bytes: a canary of exactly that length.
const masterKey = `SRCANARY_MASTER_${nonce()}`;
// A PKCS#8 PEM body allows base64 characters only.
const privateKeyBody = `SRCANARYPRIVATEKEY${nonce()}`;
const buyerEmail = `srcanary.buyer.${nonce()}@example.com`;
const checkoutEmail = `srcanary.checkout.${nonce()}@example.com`;

/** Lines the request loggers wrote (the route harness and the fetch handler use a sink). */
const sinkLines: string[] = [];
const record = (line: string) => {
  sinkLines.push(line);
};
const sink = { debug: record, info: record, warn: record, error: record };

/** The web Worker's bindings with every secret a canary. */
const rawEnv = (extra: Record<string, unknown> = {}) => ({
  ...env,
  BETTER_AUTH_SECRET: canaries.betterAuthSecret,
  GITHUB_CLIENT_SECRET: canaries.githubClientSecret,
  GITHUB_APP_ID: "1000",
  GITHUB_APP_SLUG: "sharerepo-test",
  GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----`,
  GITHUB_WEBHOOK_SECRET: canaries.githubWebhookSecret,
  GITHUB_WEBHOOK_SECRET_PREVIOUS: canaries.githubWebhookSecretPrevious,
  CREDENTIAL_KEYS: JSON.stringify({ current: "canary", keys: { canary: btoa(masterKey) } }),
  CLAIM_SIGNING_KEY: canaries.claimSigningKey,
  EMAIL: { send: async () => undefined },
  EVENTS: { send: async () => undefined },
  ...extra,
});
const webEnv = parseWebEnv(rawEnv());
const authConfig = webEnv.auth;
const BASE = authConfig.baseURL;

/** Fails the next call of one Paddle operation with a canary and an email in the error. */
let paddleFault: keyof PaddlePort | null = null;
const providerMessage = `provider said ${canaries.providerError} about ${buyerEmail}`;
const sellers = new Map<string, FakePaddle>();
const paddleFor: CommerceDeps["paddle"] = ({ apiKey }) => {
  const fake = sellers.get(apiKey);
  if (fake === undefined) throw new Error("test: unknown Paddle key");
  return new Proxy(fake, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === paddleFault) {
          paddleFault = null;
          throw new PaddleApiError("rejected", providerMessage, {
            status: 400,
            paddleCode: canaries.providerError,
          });
        }
        return value.apply(target, args);
      };
    },
  });
};
const deps = commerceDepsFromEnv(webEnv, paddleFor) as CommerceDeps;
const github = createFakeGitHubApp();

/** A route context as the Worker entry builds it, over the canary bindings and fakes. */
function routeContext(extra: Record<string, unknown> = {}): RouterContextProvider {
  const correlationId = `corr-${crypto.randomUUID()}`;
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: parseWebEnv(rawEnv(extra)),
    ctx: createExecutionContext(),
    correlationId,
    logger: createLogger({ correlationId }, { sink }),
  });
  context.set(providerOverrides, { paddle: paddleFor, github });
  return context;
}

interface Visitor {
  readonly userId: string;
  readonly cookie: string;
  readonly login: string;
  readonly githubId: string;
}

/** Signs in through Better Auth's endpoints with the canary secrets and OAuth fake. */
async function signIn(): Promise<Visitor> {
  const auth = () =>
    createAuth({
      config: authConfig,
      github: oauth.client,
      services: {
        db,
        clock: systemClock,
        ids: randomIds,
        correlationId: `corr-${crypto.randomUUID()}`,
      },
      logger: createLogger({ correlationId: "sign-in" }, { sink }),
    });
  const started = await auth().api.signInSocial({
    body: { provider: "github", callbackURL: "/", errorCallbackURL: "/?error=sign_in_failed" },
    headers: new Headers({ origin: BASE }),
    asResponse: true,
  });
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const account = fakeAccount();
  const code = oauth.authorize(account);
  const callback = await auth().handler(
    new Request(`${BASE}/api/auth/callback/github?code=${code}&state=${state}`, {
      headers: { cookie: cookiesOf(started) },
    }),
  );
  const cookie = cookiesOf(callback);
  const session = await auth().api.getSession({ headers: new Headers({ cookie }) });
  if (session === null) throw new Error("sign-in failed");
  return { userId: session.user.id, cookie, login: account.login, githubId: account.id };
}

const get = (path: string, who: Visitor | null) =>
  new Request(`${BASE}${path}`, { headers: who === null ? {} : { cookie: who.cookie } });

let ip = 0;
function post(path: string, who: Visitor, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      cookie: who.cookie,
      origin: new URL(BASE).origin,
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": `192.0.2.${++ip}`,
    },
    body,
  });
}

type RouteFn = (args: never) => unknown;
/** Calls a loader or action as React Router would; a thrown response is returned. */
async function call(
  fn: RouteFn | undefined,
  request: Request,
  params: Record<string, string> = {},
  context = routeContext(),
): Promise<unknown> {
  if (fn === undefined) throw new Error("no such route function");
  try {
    return await fn({ request, params, context } as never);
  } catch (error) {
    // Redirects are thrown; an error status means the page refused, and the seed is wrong.
    const status =
      error instanceof Response
        ? error.status
        : (error as { init?: { status?: number } } | null)?.init?.status;
    if (status === undefined) throw error;
    if (status >= 400) throw new Error(`${request.method} ${request.url} answered ${status}`);
    return error;
  }
}

/** The fetch handler, as the Worker runs it, for the webhooks; pages render nothing here. */
const handler = createFetchHandler({
  renderApp: async () => {
    // A render that fails with secrets and personal data in its message.
    throw new Error(`render failed with ${canaries.renderError} for ${buyerEmail}`);
  },
  ids: randomIds,
  now: Date.now,
  logSink: sink,
});
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handler(request, rawEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const random = (length: number) =>
  [...crypto.getRandomValues(new Uint8Array(length))]
    .map((value) => "abcdefghijklmnopqrstuvwxyz0123456789"[value % 36])
    .join("");
let counter = Math.floor(Math.random() * 1e8);
const unique = () => String(++counter);
const services = () => ({
  db,
  clock: systemClock,
  ids: randomIds,
  correlationId: `corr-${crypto.randomUUID()}`,
});

describe("security/no-secrets-in-stored-rows-or-logs", { timeout: 60_000 }, () => {
  it("security/no-secrets-in-stored-rows-or-logs: the pages and webhooks leave no secret in a stored row or log line", async () => {
    // The owner signs in and creates a workspace through the pages.
    const owner = await signIn();
    const slug = `ws-${unique()}`;
    await call(newWorkspace.action, post("/workspaces/new", owner, { name: "Shop", slug }));
    const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
      .bind(slug)
      .first<{ id: string }>();
    if (workspace === null) throw new Error("workspace not created");
    const workspaceId = workspace.id;

    // GitHub: the App installed on the owner's account and connected, then synced.
    const installationId = unique();
    github.addInstallation({
      id: installationId,
      account: { id: owner.githubId, login: owner.login, type: "User" },
      repositories: [
        {
          externalId: unique(),
          name: `${owner.login}/course`,
          ownerExternalId: owner.githubId,
          ownerType: "User",
          private: true,
          archived: false,
        },
      ],
    });
    const started = await startGitHubConnection(
      services(),
      owner,
      slug,
      { acknowledgeWriteAccess: true },
      github,
    );
    if (!started.ok) throw new Error("connection not started");
    const state = new URL(started.installUrl).searchParams.get("state") ?? "";
    const completed = await completeGitHubConnection(
      services(),
      owner,
      { state, installationId },
      github,
    );
    if (!completed.ok) throw new Error(completed.reason);
    await resyncConnection(services(), { workspaceId, id: completed.connectionId }, github, "test");
    const resources = await listResourcesForConnection(db, {
      workspaceId,
      connectionId: completed.connectionId,
    });

    // Paddle: connect with a key through the billing page, then an offer of its price.
    const paddle = createFakePaddle({
      seller: { id: `slr_${unique().padStart(26, "0")}`, name: "Acme Seller" },
    });
    const apiKey = `pdl_sdbx_apikey_${random(26)}_${random(22)}_${random(3)}`;
    sellers.set(apiKey, paddle);
    const price = paddle.addPrice();
    const w = `/w/${slug}`;
    const params = { slug };
    // A failing connect first: Paddle's error carries a canary and an email.
    paddleFault = "getApiRoot";
    await call(
      billing.action,
      post(`${w}/billing`, owner, { intent: "connect", apiKey, apiKeyExpiresOn: "2030-01-01" }),
      params,
    );
    expect(paddleFault).toBeNull();
    await call(
      billing.action,
      post(`${w}/billing`, owner, { intent: "connect", apiKey, apiKeyExpiresOn: "2030-01-01" }),
      params,
    );
    const connection = await getPaddleConnection(db, { workspaceId });
    if (connection === null) throw new Error("Paddle not connected");
    const webhookSecrets = [paddle.secretOf(connection.destinationId as string)];
    await call(
      offers.action,
      post(`${w}/offers`, owner, {
        intent: "create",
        name: "Pro",
        gracePeriodDays: "7",
        paddlePrices: price.id,
        repositories: resources.map((r) => r.id),
      }),
      params,
    );
    const offer = await env.DB.prepare("SELECT id FROM offers WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<{ id: string }>();
    if (offer === null) throw new Error("offer not created");

    // Webhooks through the request handler: GitHub with the current and the previous secret,
    // a bad signature, and Paddle deliveries carrying an email.
    const githubRaw = JSON.stringify({
      action: "added",
      installation: { id: Number(installationId) },
      sender: { login: "someone", email: buyerEmail, note: canaries.githubPayload },
    });
    const statuses: number[] = [];
    for (const secret of [
      canaries.githubWebhookSecret,
      canaries.githubWebhookSecretPrevious,
      "wrong",
    ]) {
      const response = await fetchWorker(
        new Request(`${BASE}/webhooks/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": crypto.randomUUID(),
            "x-github-event": "installation_repositories",
            "x-hub-signature-256": await signWebhook(secret, githubRaw),
          },
          body: githubRaw,
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([202, 202, 401]);
    const customer = paddle.addCustomer({
      id: `ctm_${unique().padStart(26, "0")}`,
      email: buyerEmail,
    });
    const direct = paddle.createSubscription({ customerId: customer.id, priceIds: [price.id] });
    const delivery = await paddle.emitSubscriptionEvent(
      connection.destinationId as string,
      "subscription.created",
      direct.id,
    );
    const paddleWebhook = (rawBody: string, signature: string) =>
      fetchWorker(
        new Request(`${BASE}/webhooks/paddle/${connection.id}`, {
          method: "POST",
          headers: { "content-type": "application/json", "paddle-signature": signature },
          body: rawBody,
        }),
      );
    expect((await paddleWebhook(delivery.rawBody, delivery.signature)).status).toBe(200);
    const forged = await signPaddleWebhook("wrong", delivery.rawBody, Date.now());
    expect((await paddleWebhook(delivery.rawBody, forged)).status).toBe(401);
    // The jobs the webhook queued: processing and the subscription's refresh.
    await drain({ workspaceId, deps } as Parameters<typeof drain>[0]);
    // A page render that fails with a canary in its message, and the health check.
    await fetchWorker(get("/", owner));
    await fetchWorker(get("/healthz", null));

    // Path 1: a buyer checks out on the offer's page.
    const buyer = await signIn();
    await call(buy.loader, get(`/buy/${offer.id}`, buyer), { offerId: offer.id });
    const checkout = await call(
      buy.action,
      post(`/buy/${offer.id}`, buyer, { priceId: price.id }),
      { offerId: offer.id },
    );
    expect(checkout).toBeInstanceOf(Response);
    const checkoutUrl = (checkout as Response).headers.get("location") as string;
    const transactionId = new URL(checkoutUrl).searchParams.get("_ptxn") as string;
    const claimReference = Object.values(paddle.transaction(transactionId).customData);
    expect(claimReference).toEqual([expect.stringMatching(/^v1\./)]);
    paddle.completeCheckout(transactionId, { email: checkoutEmail });

    // Path 2: a buyer asks for claim links by email on the claim page; the link is opened.
    const claimant = await signIn();
    await call(claimRequest.loader, get(`/c/${slug}/claim`, claimant), params);
    await call(
      claimRequest.action,
      post(`/c/${slug}/claim`, claimant, { email: buyerEmail }),
      params,
    );
    const request = await env.DB.prepare(
      "SELECT subject_id FROM outbox WHERE kind = 'send_claim_email' AND workspace_id = ?",
    )
      .bind(workspaceId)
      .first<{ subject_id: string }>();
    const ref = decodeClaimRequestKey(request?.subject_id as string);
    if (!ref.ok) throw new Error("no claim request");
    const mail = createFakeMail();
    await sendClaimEmail(services(), ref.value, { ...deps, mail });
    const token = mail.inbox(buyerEmail)[0]?.text.match(/\/claim\/([A-Za-z0-9_-]+)/)?.[1];
    if (token === undefined) throw new Error("no claim email");
    await call(claim.loader, get(`/claim/${token}`, claimant), { token });
    expect(
      await call(claim.action, post(`/claim/${token}`, claimant, {}), { token }),
    ).toMatchObject({ data: { error: null } });
    await call(me.loader, get("/me/access", claimant));
    // A claim request still waiting for its job: the email is stored sealed.
    await call(
      claimRequest.action,
      post(`/c/${slug}/claim`, await signIn(), { email: checkoutEmail }),
      params,
    );

    // The owner's pages, a failing and a completed webhook secret rotation, and an export.
    for (const page of [layout, repositories, offers, access, customers, billing, simulator]) {
      await call(page.loader as RouteFn, get(w, owner), params);
    }
    await call(
      access.action,
      post(`${w}/access`, owner, { intent: "check", resourceId: resources[0]?.id ?? "" }),
      params,
    );
    paddleFault = "createNotificationSetting";
    await call(billing.action, post(`${w}/billing`, owner, { intent: "rotate_webhook" }), params);
    expect(paddleFault).toBeNull();
    paddleFault = "deleteNotificationSetting";
    await call(billing.action, post(`${w}/billing`, owner, { intent: "rotate_webhook" }), params);
    const rotating = await getPaddleConnection(db, { workspaceId });
    webhookSecrets.push(paddle.secretOf(rotating?.destinationNextId as string));
    await call(billing.action, post(`${w}/billing`, owner, { intent: "rotate_webhook" }), params);
    await call(billing.action, post(`${w}/billing`, owner, { intent: "refresh" }), params);
    await call(settings.loader, get(`${w}/settings`, owner), params);
    await call(settings.action, post(`${w}/settings`, owner, { name: "Renamed" }), params);
    const exported = await call(exporting.action, post(`${w}/export`, owner, {}), params);
    expect(exported).toBeInstanceOf(Response);
    const exportText = await (exported as Response).text();

    // A failed job, seen by the owner and an operator, retried and dismissed.
    const failed = `row-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, workspace_id, failed_at, last_error_code)
       VALUES (?, 'refresh_subscription', ?, ?, ?, 10, ?, ?, 'rejected')`,
    )
      .bind(failed, `${workspaceId}:paddle:${direct.id}`, 1, 1, workspaceId, Date.now())
      .run();
    const operatorContext = () => routeContext({ OPERATOR_GITHUB_IDS: owner.githubId });
    await call(ops.loader, get("/ops", owner), {}, operatorContext());
    await call(opsWorkspace.loader, get(`/ops/w/${slug}`, owner), params, operatorContext());
    await call(
      access.action,
      post(`${w}/access`, owner, { intent: "retry-job", outboxId: failed }),
      params,
    );
    await env.DB.prepare("UPDATE outbox SET failed_at = ?, sent_at = NULL WHERE id = ?")
      .bind(Date.now(), failed)
      .run();
    await call(
      ops.action,
      post("/ops", owner, {
        intent: "dismiss",
        outboxId: failed,
        workspaceId,
        reason: "Handled by hand",
      }),
      {},
      operatorContext(),
    );

    // The buyer from path 1 deletes their account; a second workspace's deletion is asked.
    await call(account.loader, get("/me", buyer));
    await call(account.action, post("/me", buyer, { intent: "delete", confirmation: buyer.login }));
    expect(
      await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(buyer.userId).first(),
    ).toBeNull();
    const other = await signIn();
    const otherSlug = `ws-${unique()}`;
    await call(
      newWorkspace.action,
      post("/workspaces/new", other, { name: "Old", slug: otherSlug }),
    );
    await call(
      settings.action,
      post(`/w/${otherSlug}/settings`, other, { intent: "delete", confirmation: otherSlug }),
      { slug: otherSlug },
    );
    expect(
      await env.DB.prepare("SELECT status FROM workspaces WHERE slug = ?").bind(otherSlug).first(),
    ).toEqual({ status: "deleting" });
    expect(
      await env.DB.prepare("SELECT dismissed_by FROM outbox WHERE id = ?").bind(failed).first(),
    ).toEqual({ dismissed_by: owner.userId });

    const needles: Record<string, string> = {
      ...canaries,
      githubAccessToken: signInCanaries.githubAccessToken,
      masterKey,
      privateKey: privateKeyBody,
      paddleApiKey: apiKey,
      claimLink: token,
      ...Object.fromEntries(webhookSecrets.map((secret, i) => [`paddleWebhookSecret${i}`, secret])),
      ...Object.fromEntries(claimReference.map((value, i) => [`claimReference${i}`, value])),
    };
    // Emails allowed in stored rows: only Better Auth's synthetic `auth_users.email`, which is
    // derived from the GitHub ID (`syntheticEmail`) and is no one's address. A buyer's email
    // exists only sealed in `claim_requests.email_envelope` (ciphertext, no `@`).
    const syntheticEmail = /^github-\d+@users\.sharerepo\.invalid$/;
    const emailAllowed = (stored: StoredValue, email: string) =>
      stored.table === "auth_users" &&
      stored.column === "email" &&
      syntheticEmail.test(stored.value) &&
      email === stored.value;
    const { values } = await expectNoSecretsInStoredRows(env.DB, {
      secrets: needles,
      emailAllowed,
    });
    expect(values.some((v) => v.table === "auth_users" && v.column === "email")).toBe(true);
    expect(values.some((v) => v.table === "claim_requests" && v.column === "email_envelope")).toBe(
      true,
    );

    // The logs: the request loggers' lines and the console.
    const allLines = [...sinkLines, ...logs.lines()];
    expect(allLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"msg":"unhandled error"'),
        expect.stringContaining('"msg":"webhook rejected"'),
      ]),
    );
    expectNoCanaryLeak([allLines, logs.entries], encodedNeedles(needles));
    expect(emailShapes(allLines.join("\n"))).toEqual([]);
    // The export download carries none either.
    expectNoCanaryLeak(exportText, needles);
    expect(emailShapes(exportText)).toEqual([]);
  });
});
