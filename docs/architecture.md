# ShareRepo architecture

## Architectural goals

ShareRepo must reliably converge paid access policy with actual repository access while remaining small enough for an early SaaS. The architecture optimizes for correctness, recoverability, auditability, and low operational burden rather than raw throughput.

## System shape

Use two deployables initially:

```text
Browser / providers
        |
        v
apps/web Worker
  - React Router UI and SSR
  - actions and loaders
  - auth and OAuth callbacks
  - provider callbacks and webhooks
  - narrow HTTP API routes
        |
        +------> D1
        |
        +------> Queue
                    |
                    v
apps/jobs Worker
  - queue consumers, including the dead-letter queue
  - reconciliation
  - scheduled sweeps and the outbox drain
        |
        +------> D1
        +------> GitHub / Paddle APIs
```

The web Worker accepts requests, validates them, persists durable intent or events, and responds quickly. Slow or retryable provider work belongs in the jobs Worker. D1 is the authoritative domain store, and holds every timer; queues and the transactional outbox coordinate work but are not the source of truth.

## Suggested repository layout

```text
sharerepo/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   │   ├── routes/
│   │   │   ├── components/
│   │   │   └── services/
│   │   └── worker.ts
│   └── jobs/
│       ├── queue.ts
│       └── scheduled.ts
├── packages/
│   ├── domain/
│   ├── integrations/
│   │   ├── github/
│   │   └── paddle/
│   ├── db/
│   │   ├── schema/
│   │   ├── repositories/
│   │   └── migrations/
│   ├── auth/
│   ├── ui/
│   └── testing/
├── docs/
├── package.json
├── pnpm-workspace.yaml
└── wrangler.jsonc
```

The exact package split can evolve. Avoid packages that only re-export another package or create circular domain dependencies.

## Technology choices

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, strict mode | One language across UI, domain, jobs, and adapters |
| Runtime | Cloudflare Workers | Webhooks, OAuth, HTTP, and background work |
| Web | React Router | SSR, routes, loaders/actions, callbacks, and narrow APIs |
| UI | React, Tailwind CSS, React Aria Components | Accessible primitives with styling control |
| Database | Cloudflare D1 | Relational authority for initial scale |
| Data access | Drizzle | SQL-shaped access and typed schema |
| Authentication | Better Auth | Login, sessions, OAuth handshake, and account linking |
| Validation | Zod | Parse every external boundary |
| Async delivery | Cloudflare Queues | At-least-once jobs; consumers must be idempotent |
| Timers | D1 columns swept by Cron Triggers | Grace expiry, effective cancellation and every other boundary; no Workflows ([decision 0013](decisions/0013-database-timers-and-expiry-confirmation.md)) |
| Repair | Cron Triggers | Scheduled, partitioned reconciliation and daily provider sweeps |
| Alerting | Workers Logs, Workers Issues, Cloudflare Monitors | Alert lines and a heartbeat, emailed to the operator ([decision 0014](decisions/0014-failure-handling-and-alerting.md)) |
| Testing | Vitest and Playwright | Domain/integration tests plus critical browser journeys |
| Tooling | pnpm, Vite, Wrangler, Biome | Minimal workspace and deployment toolchain |
| CI/CD | GitHub Actions | Explicit checks and Wrangler deployment |

Do not add a separate API framework initially. React Router endpoints are sufficient until a real public API creates a separate lifecycle. Do not add Durable Objects until per-connection serialization is shown to be necessary.

## Boundary rules

### Domain

The domain defines identities, workspaces, connections, resources, offers, subscriptions, entitlements, grants, reconciliation decisions, and audit facts. It must not import Cloudflare bindings, provider SDKs, React, Drizzle query objects, or HTTP request types.

### Application services

Application services coordinate transactions, authorization, domain calculations, repositories, provider ports, queues, and audit recording. They translate provider events into domain inputs and enqueue reconciliation.

### Integrations

Adapters own provider authentication, payload schemas, signatures, API calls, pagination, rate limits, capability mapping, and error classification. Provider payloads do not escape into the core domain.

### Infrastructure

Infrastructure binds application ports to D1, Queues, Cron, secrets, logs, and deployment configuration.

## Identity and authorization

Better Auth may own login mechanics, sessions, OAuth handshakes, and linked auth accounts. ShareRepo owns its `User`, `Workspace`, membership, provider identity, integration connection, and authorization records.

Do not equate:

```text
GitHub login identity != GitHub App installation
```

A user may log in with one GitHub identity and connect several organizations through separate installations. Each request and job must carry or resolve an explicit workspace scope.

## Desired-state reconciliation

Provisioning is a convergence loop:

```text
external event or schedule
        |
        v
refresh commercial/provider facts
        |
        v
calculate desired Entitlements
        |
        v
inspect actual Grants
        |
        v
plan: provision | revoke | verify | no-op
        |
        v
perform provider operation
        |
        v
re-inspect and persist observed state
        |
        v
append AuditEvent
```

The key comparisons are:

| Desired entitlement | Observed grant | Action |
|---|---|---|
| active | absent | provision |
| active | active | no-op or periodic verify |
| inactive/absent | active | revoke |
| active | error/pending | retry, wait, or request action |
| inactive/absent | absent | no-op |

Never assume a successful API response permanently represents provider state. Persist observations with timestamps and reconcile again.

## Webhook and job reliability

1. Verify signatures against the raw request body.
2. Parse with a versioned runtime schema.
3. Insert an external event using a unique `(provider, external_event_id)` key.
4. Acknowledge duplicates without repeating non-idempotent effects.
5. Commit the event before scheduling work.
6. Process asynchronously where provider calls or retries are possible.
7. Re-read current authoritative state during processing; do not trust stale job payloads.
8. Use deterministic idempotency keys for mutations and jobs.
9. Classify failures as retryable, terminal, rate-limited, or user-action-required.
10. Send exhausted work to an inspectable failure path and alert the operator.

Out-of-order events must converge by fetching or comparing current provider state, not by “last webhook processed wins.”

## Transactions and invariants

D1 should enforce stable facts where possible:

- unique external events per provider;
- unique connections per workspace/provider/external connection;
- unique resources per connection/provider external ID;
- unique external identities per provider/provider user ID;
- unique active entitlement identity for its subject/resource/access/source policy;
- unique grant identity for provider/resource/subject/access as appropriate;
- foreign keys and workspace-consistency checks;
- constrained state values and valid time ranges.

Event receipt, resulting state changes, an outbox/job intent, and audit facts should be committed atomically when they belong to one decision. If D1/Queues cannot provide an atomic cross-service commit, use a transactional outbox polled or drained by the jobs layer.

## Timers and time

Timers live in the database ([decision 0013](decisions/0013-database-timers-and-expiry-confirmation.md)). Cloudflare Workflows are not used.

1. Persist the provider event and current subscription facts.
2. Calculate `validUntil` and the next policy evaluation time (`subscriptions.next_evaluation_at`), and each repository's next check (`resources.next_reconcile_at`).
3. Every minute, the jobs Worker's sweep claims due rows with a compare-and-set and queues their work in the same `db.batch()`, so a timer cannot be lost between scheduling and running. Each tick claims a bounded number, oldest first.
4. The job reloads the current subscription and policy state from the source.
5. Recompute entitlements.
6. Reconcile provider grants.
7. Record outcome and audit facts.

The reload is essential: the customer may renew or the subscription may change before the boundary is processed. A sweep that runs twice, or a job delivered twice, changes nothing the second time.

**Expiry is confirmed before revocation.** An active entitlement past its `validUntil` is *expiry pending*: reconciliation grants nothing new for it and revokes nothing, until the refresh re-reads the source and ends it, or until 6 hours have passed (`EXPIRY_CONFIRMATION_WINDOW_MS`). A lost renewal webhook therefore never revokes a paying subscriber, and a source that stays unreadable still cannot keep access for ever.

**The sweep is observed.** Each minute tick logs a heartbeat with what it claimed and the oldest due instants. A Monitor emails when the heartbeat stops, and an alert line fires when the oldest due row is more than 15 minutes late.

**Daily work is spread.** The daily cron queues each connection's GitHub resync and Paddle sweep, data pruning and due workspace purges with a delay derived from a hash of the job, so provider calls are spread over the day. The minute sweep queues at most 10 repository checks per GitHub installation, and none for an installation that is rate limited.

## Failure handling and operations

Decision [0014](decisions/0014-failure-handling-and-alerting.md) makes every failure that needs a person a row, an audit event and an email.

- **Failed jobs are outbox rows** with `failed_at` and a classified error code, and a `job.failed` audit event. The outbox drain backs off a retryable failure (1 minute doubling, at most 2 hours) for about 6 hours before failing it. The queue hands a retryable job to the drain on its last retries. A dead-letter queue catches messages whose consumer crashed or timed out; the jobs Worker consumes it and fails the matching row.
- **Owners** see their workspace's failed jobs, repositories that keep failing and a waiting deletion on the Access page, and can retry their own failed jobs.
- **Operators** are users whose GitHub account ID is listed in `OPERATOR_GITHUB_IDS`. There is no operator role in the database. `/ops` shows every workspace's failures, unhealthy connections, waiting deletions and sweep health; operators retry or dismiss failures and open a workspace's Access page read-only. Operator routes call the same workspace-scoped services with an explicit operator principal, and every operator action is audited.
- **Alert lines** (`alert: <name>`, IDs only) and Workers Issues reach the operator by email.

## Data lifecycle

Decision [0015](decisions/0015-data-lifecycle.md):

- A daily job prunes operational data past its retention (webhook receipts, sent and dismissed jobs, used claims, settled provider mutations, expired sessions) in bounded batches, never a row something still references. Audit events live as long as their workspace or account.
- An owner can export a workspace as JSON, without credentials or emails.
- Deleting a workspace ends every entitlement, revokes the access ShareRepo granted, and purges every workspace-owned row, audit events included, 30 days later and only once no managed access remains. An account-scoped tombstone records the counts.
- Deleting an account unlinks the user's GitHub account from every subject and customer, ends that access, and deletes their identity, sessions and memberships at once.

## Security and privacy

- Request the smallest viable GitHub App permissions and repository selection.
- Verify all webhook signatures and OAuth state/PKCE requirements.
- Encrypt tenant credentials in D1 with authenticated encryption and versioned key envelopes.
- Keep master keys, app private keys, and webhook secrets in Cloudflare secrets.
- Redact credentials and sensitive payload fields from logs and errors.
- Authorize every user-facing and background operation against an explicit workspace.
- Protect against confused-deputy attacks when callbacks bind installations or seller accounts.
- Define retention for raw events and personal data; support deletion without corrupting financial/audit obligations.
- Audit credential connection, disconnection, access decisions, provider mutations, and manual operator actions.

## Observability

Use structured logs and traces with:

- request, event, job, workspace, connection, entitlement, and grant correlation IDs;
- provider operation names and normalized outcomes;
- retry counts and rate-limit metadata;
- reconciliation duration and drift counts;
- no secrets or unnecessary personal data.

Initial operational views should answer: What failed? Is access incorrect now? Will it retry? Does a user need to act? What decision created or removed access?

The owner's Access page and the operator's `/ops` answer the first four; the audit history answers the last. The procedures are in the runbooks: [incident response](runbooks/incident-response.md), [failure triage](runbooks/failure-triage.md) and [alerting setup](runbooks/alerting-setup.md).

## Portability and self-hosting

Portability is a design constraint, not a v1 deliverable. Keep domain logic independent of Cloudflare, use ports for storage/jobs/secrets/provider operations, package ordinary schema migrations, and avoid reliance on a proprietary ShareRepo control plane. It is acceptable for the initial production adapters and deployment instructions to target Cloudflare only.

