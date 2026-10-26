import { env } from "cloudflare:workers";
import {
  authorizeOperator,
  type CommerceDeps,
  confirmClaim,
  connectPaddle,
  createOffer,
  createUserForSignIn,
  deleteAccount,
  dismissFailure,
  encodePaddleConnectionKey,
  exportWorkspace,
  ingestGitHubWebhook,
  ingestPaddleWebhook,
  recordSignIn,
  requestClaim,
  requestWorkspaceDeletion,
  retryFailure,
  rotatePaddleWebhookSecret,
  startCheckout,
  type UserActor,
  viewClaim,
} from "@sharerepo/application";
import { enqueueOutbox, getPaddleConnection, listResourcesForConnection } from "@sharerepo/db";
import {
  type GitHubUserId,
  OUTBOX_KINDS,
  type OutboxKind,
  parseGitHubLogin,
  WORKSPACE_DELETION_DELAY_MS,
} from "@sharerepo/domain";
import { GitHubApiError, PaddleApiError, type PaddlePort } from "@sharerepo/integrations";
import {
  createFakeGitHubApp,
  createFakeMail,
  createFakePaddle,
  type FakePaddle,
  type FakePaddleDelivery,
  signWebhook,
} from "@sharerepo/integrations/testing";
import { parseCommerceSecrets } from "@sharerepo/platform";
import {
  captureLogs,
  createSecretCanaries,
  emailShapes,
  encodedNeedles,
  expectNoCanaryLeak,
  expectNoSecretsInStoredRows,
  type LogCapture,
} from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import { act, DAY, shop, subscribe } from "./support/commerce.ts";
import { clock, connectedCreator, db, envWithGitHub, serviceContext } from "./support/github.ts";
import { deliver, jobsWorker, runCron } from "./support/worker.ts";

// security/no-secrets-in-stored-rows-or-logs (Phase 6 acceptance; threats O6 and O18), at the
// jobs Worker's entry points. One broad seed drives the main services and every job kind with a
// canary for every secret ShareRepo holds or receives, then every text value of every table and
// every captured log line is scanned for the canaries (as written, hex or base64) and for email
// shapes. Failure paths carry canaries and emails in provider error messages and codes.

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

const canaries = createSecretCanaries([
  "claimSigningKey",
  "githubWebhookSecret",
  "githubPayload",
  "paddlePayload",
  "providerError",
  "queueMessage",
]);
const nonce = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
// AES-256 master keys must be 32 bytes: canaries of exactly that length, used as the key bytes.
const masterKey = `SRCANARY_MASTER_${nonce()}`;
const retiredMasterKey = `SRCANARY_RETIRE_${nonce()}`;
// A PKCS#8 PEM body allows base64 characters only.
const privateKeyBody = `SRCANARYPRIVATEKEY${nonce()}`;
// Buyers' emails: personal data that may exist only sealed in a claim request's envelope.
const buyerEmail = `srcanary.buyer.${nonce()}@example.com`;
const checkoutEmail = `srcanary.checkout.${nonce()}@example.com`;

/** The jobs Worker's bindings with every ShareRepo-owned secret a canary. */
const bindings = {
  ...envWithGitHub,
  GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\\n${privateKeyBody}\\n-----END PRIVATE KEY-----`,
  CREDENTIAL_KEYS: JSON.stringify({
    current: "canary-new",
    keys: { "canary-new": btoa(masterKey), "canary-old": btoa(retiredMasterKey) },
  }),
  CLAIM_SIGNING_KEY: canaries.claimSigningKey,
  // Any object with `send` passes as the send_email binding; the Worker's mail port is the fake.
  EMAIL: { send: () => Promise.resolve({ messageId: "unused" }) },
} as Env;

const secrets = (() => {
  const parsed = parseCommerceSecrets(bindings);
  if (parsed === null) throw new Error("test: commerce secrets did not parse");
  return parsed;
})();

/** Fails the next call of one Paddle operation with a canary and an email in the error. */
let paddleFault: keyof PaddlePort | null = null;
const providerMessage = `provider said ${canaries.providerError} about ${buyerEmail}`;

function faulty(fake: FakePaddle): PaddlePort {
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
}

/** Paddle accounts by key: each key resolves to its seller's fake. */
const sellers = new Map<string, FakePaddle>();
const paddleFor = (apiKey: string) => {
  const fake = sellers.get(apiKey);
  if (fake === undefined) throw new Error("test: unknown Paddle key");
  return faulty(fake);
};

/** Commerce for the services, sealing under `current` (the retired key, to exercise rewrap). */
const commerce = (current: string): CommerceDeps => ({
  paddle: ({ apiKey }) => paddleFor(apiKey),
  credentialKeys: { ...secrets.credentialKeys, current },
  claimSigningKeys: secrets.claimSigningKeys,
  baseUrl: env.PUBLIC_BASE_URL,
  deployment: "development",
});

const random = (length: number) =>
  [...crypto.getRandomValues(new Uint8Array(length))]
    .map((value) => "abcdefghijklmnopqrstuvwxyz0123456789"[value % 36])
    .join("");

let counter = Math.floor(Math.random() * 1e8);
const unique = () => String(++counter);

/** A user who signed in with GitHub, with their login. */
async function signedUp(): Promise<UserActor & { login: string; githubId: string }> {
  const { userId } = await createUserForSignIn(serviceContext());
  const githubId = unique();
  const login = parseGitHubLogin(`buyer-${githubId}`);
  if (!login.ok) throw new Error(login.error);
  await recordSignIn(
    serviceContext(),
    { userId },
    {
      provider: "github",
      externalUserId: githubId as GitHubUserId,
      username: login.value,
      displayName: null,
      avatarUrl: null,
    },
  );
  return { userId, login: login.value, githubId };
}

async function queuedJob(kind: OutboxKind, subjectId: string, workspaceId: string | null) {
  const outboxId = `row-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id: outboxId,
    kind,
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
    workspaceId,
  });
  return { kind, subjectId, outboxId };
}

/** Kinds that ran to an end (sent or failed); collected before pruning removes old rows. */
const ranKinds = new Set<string>();
async function noteRanKinds() {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT kind FROM outbox WHERE sent_at IS NOT NULL OR failed_at IS NOT NULL",
  ).all<{ kind: string }>();
  for (const row of results) ranKinds.add(row.kind);
}

describe("security/no-secrets-in-stored-rows-or-logs", { timeout: 60_000 }, () => {
  it("security/no-secrets-in-stored-rows-or-logs: every job kind and service leaves no secret in a stored row or log line", async () => {
    const github = createFakeGitHubApp({ clock });
    const mail = createFakeMail();
    const worker = jobsWorker(github, {
      paddle: ({ apiKey }) => paddleFor(apiKey),
      mail: () => mail,
    });
    const drain = async () => {
      await runCron(worker, CRONS.drainOutbox, bindings);
      await noteRanKinds();
    };
    const sealedUnderRetired = commerce("canary-old");
    const deps = commerce("canary-new");

    // A creator: sign-in, workspace, GitHub installation and connection, resync, and an offer
    // of a simulated item with a subscriber (refresh, reconcile, recompute).
    const s = await shop(github);
    const simulated = await subscribe(s);
    await act(s, simulated.id, "cancel_at_period_end");

    // A GitHub webhook signed with a canary secret, whose payload carries a canary and an email.
    const githubRaw = JSON.stringify({
      action: "added",
      installation: { id: Number(s.installationId) },
      sender: { login: "someone", email: buyerEmail, note: canaries.githubPayload },
    });
    const githubWebhook = await ingestGitHubWebhook(serviceContext(), {
      secrets: [canaries.githubWebhookSecret],
      rawBody: new TextEncoder().encode(githubRaw).buffer as ArrayBuffer,
      headers: new Headers({
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": "installation_repositories",
        "x-hub-signature-256": await signWebhook(canaries.githubWebhookSecret, githubRaw),
      }),
    });
    expect(githubWebhook.status).toBe("accepted");

    // Paddle: a key sealed under the retired master key, a destination and its secret.
    const paddle = createFakePaddle({
      clock,
      seller: { id: `slr_${unique().padStart(26, "0")}`, name: "Acme Seller" },
    });
    const apiKey = `pdl_sdbx_apikey_${random(26)}_${random(22)}_${random(3)}`;
    sellers.set(apiKey, paddle);
    const price = paddle.addPrice();
    const connected = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey, apiKeyExpiresOn: clock.now() + 300 * DAY },
      sealedUnderRetired,
    );
    if (!connected.ok) throw new Error(JSON.stringify(connected.error));
    const connection = await getPaddleConnection(db, { workspaceId: s.workspaceId });
    const destinationId = connection?.destinationId as string;
    const webhookSecrets = [paddle.secretOf(destinationId)];
    const paddleOffer = await createOffer(serviceContext(), s, s.slug, {
      name: "Paddle Pro",
      gracePeriodDays: 7,
      items: [{ source: "paddle", externalItemId: price.id }],
      accesses: (
        await listResourcesForConnection(db, {
          workspaceId: s.workspaceId,
          connectionId: s.connection.id,
        })
      ).map((resource) => ({ resourceId: resource.id, accessLevel: "write" as const })),
    });
    if (!paddleOffer.ok) throw new Error(JSON.stringify(paddleOffer.errors));

    const ingest = async (delivery: FakePaddleDelivery) => {
      const result = await ingestPaddleWebhook(
        serviceContext(),
        {
          connectionId: connected.connectionId,
          rawBody: new TextEncoder().encode(delivery.rawBody).buffer as ArrayBuffer,
          signatureHeader: delivery.signature,
        },
        deps,
      );
      expect(["accepted", "duplicate"]).toContain(result.status);
    };

    // A purchase through a shared link (claimed by email, path 2).
    const customer = paddle.addCustomer({
      id: `ctm_${unique().padStart(26, "0")}`,
      email: buyerEmail,
    });
    const direct = paddle.createSubscription({ customerId: customer.id, priceIds: [price.id] });
    await ingest(
      await paddle.emitSubscriptionEvent(destinationId, "subscription.created", direct.id),
    );
    // Events whose payloads carry an email and a canary, and an API key event.
    await ingest(
      await paddle.emit({
        settingId: destinationId,
        eventType: "customer.updated",
        data: { id: customer.id, email: buyerEmail, note: canaries.paddlePayload },
      }),
    );
    await ingest(
      await paddle.emit({
        settingId: destinationId,
        eventType: "api_key.expiring",
        data: { id: `apikey_${unique().padStart(26, "0")}`, name: canaries.paddlePayload },
      }),
    );

    // Path 1: a signed-in buyer checks out, pays with an email, and the purchase links.
    const checkoutBuyer = await signedUp();
    const started = await startCheckout(
      serviceContext(),
      { offerId: paddleOffer.offer.id, priceId: price.id, user: checkoutBuyer, ip: "203.0.113.9" },
      deps,
    );
    if (!started.ok) throw new Error(started.reason);
    const transactionId = new URL(started.checkoutUrl).searchParams.get("_ptxn") as string;
    const claimReference = Object.values(paddle.transaction(transactionId).customData);
    expect(claimReference).toEqual([expect.stringMatching(/^v1\./)]);
    const paid = paddle.completeCheckout(transactionId, { email: checkoutEmail });
    await ingest(
      await paddle.emitSubscriptionEvent(destinationId, "subscription.created", paid.id),
    );
    await drain();

    // Path 2: another buyer asks for claim links by email; the job emails a link.
    const claimant = await signedUp();
    const requested = await requestClaim(
      serviceContext(),
      { workspaceSlug: s.slug, email: buyerEmail, user: claimant, ip: "203.0.113.7" },
      sealedUnderRetired,
    );
    expect(requested.status).toBe("requested");
    await drain();
    const claimLink = mail.inbox(buyerEmail)[0]?.text.match(/\/claim\/([A-Za-z0-9_-]+)/)?.[1];
    if (claimLink === undefined) throw new Error("no claim email");
    expect((await viewClaim(serviceContext(), { token: claimLink, user: claimant })).ok).toBe(true);
    expect((await confirmClaim(serviceContext(), { token: claimLink, user: claimant })).ok).toBe(
      true,
    );
    // A second request whose email fails to send.
    mail.failNext("rejected");
    const pending = await requestClaim(
      serviceContext(),
      { workspaceSlug: s.slug, email: buyerEmail, user: await signedUp(), ip: "203.0.113.8" },
      sealedUnderRetired,
    );
    expect(pending.status).toBe("requested");
    await drain();

    // A webhook secret rotation that stops after its first step: the next secret is stored.
    paddleFault = "deleteNotificationSetting";
    await expect(rotatePaddleWebhookSecret(serviceContext(), s, s.slug, deps)).rejects.toThrow();
    const rotating = await getPaddleConnection(db, { workspaceId: s.workspaceId });
    const nextDestinationId = rotating?.destinationNextId as string;
    webhookSecrets.push(paddle.secretOf(nextDestinationId));
    for (const delivery of await paddle.emitToAll({
      eventType: "subscription.updated",
      data: { id: direct.id },
    })) {
      await ingest(delivery);
    }

    // Jobs no service queues here: a key check and a Paddle sweep, through the queue.
    const connectionKey = encodePaddleConnectionKey({
      workspaceId: s.workspaceId,
      connectionId: connected.connectionId,
    });
    await deliver(
      worker,
      [
        await queuedJob("check_paddle_connection", connectionKey, s.workspaceId),
        await queuedJob("sweep_paddle_subscriptions", connectionKey, s.workspaceId),
      ],
      { bindings },
    );

    // Failure paths, each carrying a canary and an email in the provider's error.
    // GitHub refuses a reconcile for good.
    const [reconcile] = await env.DB.prepare(
      "SELECT kind, subject_id AS subjectId FROM outbox WHERE kind = 'reconcile_resource' LIMIT 1",
    )
      .all<{ kind: OutboxKind; subjectId: string }>()
      .then((r) => r.results);
    if (reconcile === undefined) throw new Error("no reconcile was queued");
    github.failNext(
      "listCollaborators",
      new GitHubApiError("rejected", providerMessage, {
        status: 422,
        githubErrorCodes: [canaries.providerError],
      }),
    );
    const failedReconcile = await queuedJob(
      "reconcile_resource",
      reconcile.subjectId,
      s.workspaceId,
    );
    await deliver(worker, [failedReconcile], { bindings });
    // Paddle refuses a refresh for good, and fails a sweep on the drain's last attempt.
    const refreshKey = `${s.workspaceId}:paddle:${direct.id}`;
    paddleFault = "getSubscription";
    const failedRefresh = await queuedJob("refresh_subscription", refreshKey, s.workspaceId);
    await deliver(worker, [failedRefresh], { bindings });
    paddleFault = "listSubscriptions";
    await queuedJob("sweep_paddle_subscriptions", connectionKey, s.workspaceId);
    await drain();
    // A transient GitHub error is retried with a delay; a refused resync fails for good.
    for (const kind of ["transient", "rejected"] as const) {
      github.failNext(
        "getInstallation",
        new GitHubApiError(kind, providerMessage, {
          status: kind === "transient" ? 503 : 422,
          githubErrorCodes: [canaries.providerError],
        }),
      );
      await deliver(
        worker,
        [await queuedJob("resync_connection", s.connection.id, s.workspaceId)],
        { bindings },
      );
    }
    // A dead-lettered job, an invalid dead-lettered message and a poison job message, each
    // carrying a canary.
    const deadLettered = await queuedJob(
      "refresh_subscription",
      `${s.workspaceId}:simulated:${simulated.id}`,
      s.workspaceId,
    );
    await deliver(
      worker,
      [deadLettered, { kind: "nope", subjectId: canaries.queueMessage, email: buyerEmail }],
      { bindings, queue: "sharerepo-events-dlq-dev" },
    );
    await deliver(
      worker,
      [
        { kind: "refresh_subscription", subjectId: canaries.queueMessage, outboxId: "missing" },
        { kind: "nope", subjectId: canaries.queueMessage, outboxId: buyerEmail },
      ],
      { bindings },
    );

    // An owner retries one failure; an operator dismisses another.
    await noteRanKinds();
    expect(await retryFailure(serviceContext(), s, s.slug, failedRefresh.outboxId)).toMatchObject({
      outboxId: failedRefresh.outboxId,
    });
    const identity = await env.DB.prepare(
      "SELECT external_user_id AS id FROM external_identities WHERE user_id = ?",
    )
      .bind(s.userId)
      .first<{ id: string }>();
    const operator = await authorizeOperator(
      serviceContext(),
      s,
      new Set([identity?.id as string]),
    );
    if (operator === null) throw new Error("not an operator");
    const openFailure = await env.DB.prepare(
      "SELECT id FROM outbox WHERE workspace_id = ? AND failed_at IS NOT NULL AND id != ? LIMIT 1",
    )
      .bind(s.workspaceId, failedRefresh.outboxId)
      .first<{ id: string }>();
    expect(
      await dismissFailure(serviceContext(), operator, {
        workspaceId: s.workspaceId,
        outboxId: openFailure?.id as string,
        reason: "Handled by hand",
      }),
    ).toMatchObject({ ok: true });

    // An export (its document is checked too), and a second workspace whose deletion is asked.
    const exported = await exportWorkspace(serviceContext(), s, s.slug);
    if (!exported.ok) throw new Error(exported.reason);
    const doomed = await connectedCreator(github);
    expect(
      (
        await requestWorkspaceDeletion(
          serviceContext(),
          doomed,
          doomed.slug,
          { confirmation: doomed.slug },
          deps,
        )
      ).ok,
    ).toBe(true);
    await drain();
    // A claim request whose job has not run yet: its email is stored sealed, for the scan.
    const unsent = await requestClaim(
      serviceContext(),
      { workspaceSlug: s.slug, email: checkoutEmail, user: await signedUp(), ip: "203.0.113.10" },
      sealedUnderRetired,
    );
    expect(unsent.status).toBe("requested");

    const needles: Record<string, string> = {
      ...canaries,
      masterKey,
      retiredMasterKey,
      privateKey: privateKeyBody,
      paddleApiKey: apiKey,
      claimLink,
      ...Object.fromEntries(webhookSecrets.map((secret, i) => [`paddleWebhookSecret${i}`, secret])),
      ...Object.fromEntries(claimReference.map((value, i) => [`claimReference${i}`, value])),
    };
    // No email is allowed in plaintext anywhere: a buyer's email exists only sealed in its claim
    // request's `email_envelope` (ciphertext, which has no `@`) and as a keyed `email_hash`.
    // Better Auth's synthetic emails exist only at the web Worker, where that test allows them.
    const scan = () => expectNoSecretsInStoredRows(env.DB, { secrets: needles });
    const first = await scan();
    // The scan saw the seeded rows: the pending claim request's sealed email among them.
    expect(
      first.values.some((v) => v.table === "claim_requests" && v.column === "email_envelope"),
    ).toBe(true);
    expect(
      first.values.some(
        (v) => v.table === "paddle_connections" && v.column === "webhook_secret_next_envelope",
      ),
    ).toBe(true);

    // The daily cron: Paddle sweeps, the rewrap of envelopes under the retired key, resyncs and
    // the lifecycle jobs; then the day passes and the drain runs them.
    await runCron(worker, CRONS.heartbeat, bindings);
    await runCron(worker, CRONS.dailyResync, bindings);
    clock.advance(DAY + 3_600_000);
    await drain();
    await drain();
    // The rotation completes; the buyer from path 1 deletes their account.
    expect((await rotatePaddleWebhookSecret(serviceContext(), s, s.slug, deps)).ok).toBe(true);
    expect(
      (await deleteAccount(serviceContext(), checkoutBuyer, { confirmation: checkoutBuyer.login }))
        .ok,
    ).toBe(true);
    await drain();
    await scan();

    // A month later the deleted workspace is purged, and old rows are pruned.
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    await runCron(worker, CRONS.dailyResync, bindings);
    clock.advance(DAY + 3_600_000);
    await drain();
    await drain();
    await scan();

    // Every job kind ran (or failed) at the Worker's entry points.
    expect([...ranKinds].sort()).toEqual([...OUTBOX_KINDS].sort());
    // The deleted workspace was purged, leaving its tombstone.
    expect(
      await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?")
        .bind(doomed.connection.workspaceId)
        .first(),
    ).toBeNull();
    // The failure paths ran: both providers' errors were logged (by classification), and alert
    // lines were raised for the final failures and the dead-lettered job.
    expect(paddleFault).toBeNull();
    const logged = logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const errorName of ["GitHubApiError", "PaddleApiError"]) {
      expect(logged).toContainEqual(expect.objectContaining({ errorName, errorKind: "rejected" }));
    }
    expect(logged).toContainEqual(
      expect.objectContaining({ msg: "job will be retried", errorKind: "transient" }),
    );
    expect(logged).toContainEqual(expect.objectContaining({ alert: "job_failed" }));
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM outbox WHERE id = ? AND last_error_code = 'dead_lettered'",
      )
        .bind(deadLettered.outboxId)
        .first(),
    ).not.toBeNull();

    // The logs: no canary in any form, no email.
    expectNoCanaryLeak(logs.entries, encodedNeedles(needles));
    expect(emailShapes(logs.text())).toEqual([]);
    // The export carries none either.
    expectNoCanaryLeak(exported.document, needles);
    expect(emailShapes(JSON.stringify(exported.document))).toEqual([]);
  });
});
