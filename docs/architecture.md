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
  - queue consumers
  - reconciliation
  - scheduled jobs
  - Workflow entry points
        |
        +------> D1
        +------> GitHub / Paddle APIs
```

The web Worker accepts requests, validates them, persists durable intent or events, and responds quickly. Slow or retryable provider work belongs in the jobs Worker. D1 is the authoritative domain store; queues and workflows coordinate work but are not the source of truth.

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
│       ├── scheduled.ts
│       └── workflows/
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
| Durable orchestration | Cloudflare Workflows | Delays, retries, and multi-step state changes |
| Repair | Cron Triggers | Scheduled full or partitioned reconciliation |
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

Infrastructure binds application ports to D1, Queues, Workflows, Cron, secrets, logs, and deployment configuration.

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
8. Use deterministic idempotency keys for mutations and workflow instances.
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

## Workflows and time

Use Workflows for durable processes such as effective cancellation and grace-period expiry:

1. Persist the provider event and current subscription facts.
2. Calculate `validUntil` or the next policy evaluation time.
3. Sleep until that time.
4. Reload the current subscription and policy state.
5. Recompute entitlements.
6. Reconcile provider grants.
7. Record outcome and audit facts.

The reload is essential: the customer may renew or the subscription may change while the workflow sleeps. Workflow retries must be safe.

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

- request, event, job, workflow, workspace, connection, entitlement, and grant correlation IDs;
- provider operation names and normalized outcomes;
- retry counts and rate-limit metadata;
- reconciliation duration and drift counts;
- no secrets or unnecessary personal data.

Initial operational views should answer: What failed? Is access incorrect now? Will it retry? Does a user need to act? What decision created or removed access?

## Portability and self-hosting

Portability is a design constraint, not a v1 deliverable. Keep domain logic independent of Cloudflare, use ports for storage/jobs/secrets/provider operations, package ordinary schema migrations, and avoid reliance on a proprietary ShareRepo control plane. It is acceptable for the initial production adapters and deployment instructions to target Cloudflare only.

