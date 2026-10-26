# 0011 — Paddle connection by API key, automatic webhook destination, encrypted tenant credentials

**Status:** Accepted (connection path and webhook setup are product decisions, 2026-10-24)

## Context

Phase 5 replaces the simulated commercial source with Paddle. `integrations.md` prefers a supported OAuth connection and allows API credentials as a temporary variant. The research ([paddle-billing.md](../research/paddle-billing.md)) found:

- **OAuth.** Paddle's OAuth apps launched on 2026-06-26, behind a publisher-program application. Their mechanics are not public.
- **API keys.** They carry granular permissions and expire after one year at most. `GET /` identifies the seller (`slr_…`) and lists the key's permissions.
- **Notification destinations.** They can be created by API, and the response returns the signing secret. Only 10 can be active per seller account. A destination keeps delivering after the key that created it is revoked.

ShareRepo must hold a creator's API key and webhook secret. `AGENTS.md` requires tenant credentials to be stored as encrypted, versioned envelopes, with the master key kept outside D1.

## Decision

### Connection: a seller-created API key now, OAuth later

- **One Paddle connection per workspace.** The creator pastes a key they created for ShareRepo.
  - ShareRepo validates the key format with Zod (`pdl_(live|sdbx)_apikey_…`) and takes the environment from the prefix.
  - Legacy 50-character keys, which carry no permissions, are refused.
  - Production accepts only live keys. Other environments accept only sandbox keys.
- **Identity and permissions.** `GET /` must return a seller account (`slr_…`) in the matching environment and include every required permission:
  - `product.read`, `price.read`, `customer.read`, `subscription.read`, `transaction.read`;
  - `transaction.write`, to create checkouts with a claim reference (decision 0012);
  - `notification_setting.write`, to manage the destination.

  `account.read` is optional; it supplies the display name. A missing permission is a connect error that names it.
- **Replacing a key** (rotation, or after expiry or revocation) is a reconnect, and the new key must belong to the same seller. Connecting a different seller requires a disconnect first, so subscriptions are never silently re-homed.
- **The connect form also asks for the key's expiry date**, because the API does not report it. ShareRepo warns on the billing page from 14 days before that date.
- **Health.**
  - A `401` or `403` on any call, or a failed `GET /` probe, marks the connection `unauthorized`. The billing page then asks for a new key.
  - The `api_key.expiring`, `api_key.expired` and `api_key.revoked` webhooks trigger a probe. Their payloads do not say which key they concern.
  - While the connection is `unauthorized`, processing keeps the last known commercial facts. Entitlements are not revoked because ShareRepo cannot read Paddle.
- **OAuth** becomes a second credential kind, `oauth`, once Paddle approves ShareRepo's application. The connection row already carries `credential_kind`.

### Webhook destination: created and deleted by ShareRepo

- **On connect,** ShareRepo creates one notification destination (`POST /notification-settings`):
  - the destination is `https://<host>/webhooks/paddle/<connectionId>`;
  - `api_version: 1`, `traffic_source: platform` and `include_sensitive_fields: false`;
  - the subscribed events are `subscription.*`, `transaction.completed`, `transaction.paid`, `transaction.payment_failed` and `api_key.*`.

  ShareRepo stores the `ntfset_…` ID and the encrypted `endpoint_secret_key`.
  - If the seller already has 10 active destinations, the connect fails with that reason and no other state is written.
  - The connect page says plainly that this permission lets ShareRepo receive every event in the seller's account. ShareRepo stores only event metadata and a digest, never payloads.
- **The URL carries the connection ID,** so the right secret is chosen before the body is parsed. The signature is verified on the raw bytes: `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 of `ts:body`.
  - Any `h1` may match.
  - `ts` may be at most 5 minutes in the future and 72 hours in the past. Live retries span about 2 days, and Paddle does not say whether a retry carries a fresh `ts`. Replays inside that window are harmless, because events are deduplicated and only trigger a re-read.
- **Disconnect** deletes the destination, then the stored credentials.
  - If the key no longer works, the page shows the `ntfset_…` ID and asks the creator to delete it in Paddle. Deliveries to a disconnected connection get `404`.
  - Disconnecting keeps the workspace's customers, subscriptions and entitlements as history. Processing stops reading Paddle for them.
- **Rotating the webhook secret** is deferred to Phase 6. Paddle has no rotation call, so the procedure will be: create a second destination, accept both secrets, then delete the old one.

### Tenant credentials are envelope-encrypted

- **Every tenant secret** (the API key, the webhook secret) is stored as an envelope:
  - a fresh 256-bit data key encrypts the secret with AES-256-GCM;
  - the data key is wrapped with AES-256-GCM under a master key;
  - the envelope records its format version, the master-key ID, both IVs and both ciphertexts as JSON.
- **The additional authenticated data** binds an envelope to its row and purpose: `workspaceId:connectionId:purpose`. A ciphertext copied to another row or tenant does not decrypt.
- **Master keys** live in the Cloudflare secret `CREDENTIAL_KEYS`. It holds a JSON keyring `{"current": "k2", "keys": {"k1": "<base64>", "k2": "<base64>"}}`, used by the web and jobs Workers.
  - Rotation: add a key, make it current, and keep the old one for decryption.
  - An envelope under a non-current key is re-wrapped the next time it is used.
  - The old key is removed only after no envelope references it.
- **Plaintext is confined.** Decrypted secrets exist only in the adapter call that needs them. They never enter logs, audit details, errors, outbox rows or the domain. The redaction canaries cover both secrets and the keyring.

### Calls and limits

- **Requests:** `Paddle-Version: 1`, a 20-second timeout, and cursor pagination capped at 30 pages.
- **Errors:**
  - `429` is transient and honours `Retry-After`;
  - `5xx` and timeouts are transient;
  - `401` and `403` are `unauthorized`;
  - `404` is "not found";
  - anything else is "rejected".
- **No rate-limit coordination yet.** Paddle limits each IP to 240 requests per minute, and Workers share egress IPs. Phase 5 relies on webhooks and per-event refreshes rather than polling. The daily repair lists subscriptions page by page. A central rate limiter waits until the volume needs one.

## Consequences

- A creator can connect without waiting for Paddle's approval. In exchange they create and periodically replace a key, and ShareRepo holds a credential with broad event visibility.
- ShareRepo can sell only through checkouts that open on the creator's own approved domain (decision 0012).
- Losing `CREDENTIAL_KEYS` makes every stored tenant credential unreadable, and every creator must reconnect. The deployment runbook treats it like the GitHub App private key.

## Amendment — rotation (Phase 6 T5)

- **Webhook secret.** The billing page's "Rotate webhook secret" creates a second destination for the same connection URL with a `?v=<id>` marker (Paddle refuses duplicate URLs; the route reads the connection from the path only). It stores the new ID and secret in `destination_next_id` and `webhook_secret_next_envelope`, which is sealed with its own AAD purpose, `webhook_secret_next`. The webhook then accepts both secrets. Then it deletes the old destination and promotes the new one, re-sealing its secret for `webhook_secret`. Each step is guarded and audited as `paddle.webhook_secret_rotated` (`started`, `completed`), and re-running the action resumes it. A second destination that stopped delivering is replaced. The 10-destination limit fails cleanly with nothing changed. Disconnecting deletes both destinations and erases both secrets.
- **Master keys.** A `rewrap_credentials` job re-seals every envelope still under a listed non-current key, 50 per run. The envelopes are the API key, the webhook secret, the next secret and pending claim emails. The daily cron queues it while such envelopes exist, and each run is audited as `credentials.rewrapped` with counts. Once that reports none remaining, the old key can be removed ([secret-rotation.md](../runbooks/secret-rotation.md) § 1).

## Amendment — orphaned destinations are swept; rewrap runs move past failures (Phase 6 risk fixes)

The operations threat model accepted three ways to leave a destination in Paddle that no stored row names: a create response lost in transit, a Worker stopped between creating a destination and storing it, and a rotation racing a disconnect. Each kept delivering to ShareRepo (refused with `401` or `404`) and used one of the seller's 10 slots until the creator deleted it by hand.

- **Destinations are tagged.** Paddle's notification settings have no creation time or owner field, but keep their `description` (1–500 characters). ShareRepo now describes each destination it creates as `ShareRepo workspace <workspaceId> created <ISO instant>` (`destinationDescription`, `packages/integrations/src/paddle/destination-tag.ts`). Destinations created before this have the description `ShareRepo` and a URL naming the connection.
- **A sweep deletes the workspace's orphans.** It lists the seller's settings (`GET /notification-settings`, every page) and deletes those that are the workspace's own and that its live connection does not name (`destination_id`, `destination_next_id`). "Own" means: delivering under ShareRepo's `/webhooks/paddle/` URL, and either tagged with this workspace, or untagged `ShareRepo` and naming one of the workspace's connection IDs (any status). Another app's destination, another workspace's (one seller may connect several workspaces) and one younger than `ORPHANED_DESTINATION_GRACE_MS` (an hour, so never one a connect, reconnect or rotation is still about to store) are left alone.
  - **When:** first in the daily per-connection Paddle sweep, where a rate limit or outage fails the job as retryable; best effort after a connect, a reconnect and a completed rotation; before reporting `destination_limit` (if it frees a slot, the create is tried once more); and while disconnecting, when it deletes every one of the workspace's destinations whatever its age.
  - **Audit:** `paddle.destinations_swept` (workspace scope, target the workspace, details `reason` `orphaned` or `disconnected` and the destination IDs), written before the deletions. A crash part-way leaves the record, and the retry deletes the rest and records again. Deleting a destination already gone counts as done.
- **A lost create response is cleaned up at once.** Every new destination's URL is unique to its attempt (a new connection ID on connect; a fresh `?v=` marker on reconnect, as on rotation). When the create fails `transient`, ShareRepo lists the settings and deletes what is at that URL, best effort; otherwise the daily sweep deletes it after the grace period.
- **Disconnect re-reads on a race.** Its write is guarded on the destination IDs it read. A rotation that stores a second destination after the disconnect listed makes the write stale, so the disconnect reads the connection again and deletes that destination too (twice stale is a `ConflictError`).
- **Rewrap runs walk a cursor.** `rewrap_credentials` no longer re-reads the first 50 envelopes each run. The runs of one pass visit every envelope once, in a stable order (field, then row), each continuing after the last envelope the previous run read (`system_state` key `rewrap.cursor`, which holds a field name, a row ID and the generation). An envelope that does not open is counted in `failed` and passed over, so no number of them can starve the rest. A pass ends at the last envelope; the daily check starts another while any envelope remains, and `remaining` stays above 0 while one never opens, which the runbook checks before a key is removed.

Residual: a Worker stopped between creating a destination and storing it while the workspace disconnects at the same moment leaves a destination that only a later connect of that workspace sweeps, because a disconnected connection has no key to list with. It delivers to a disconnected connection, which answers `404`.
