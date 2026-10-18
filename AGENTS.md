# ShareRepo engineering guide

ShareRepo is a multi-tenant SaaS at `sharerepo.org` that lets creators sell and automatically provision access to private source-code repositories. Version 1 integrates GitHub for identity and repository access, and Paddle for subscriptions. GitLab and other access or entitlement providers may follow.

## Read before changing code

Start with:

- `docs/product.md` for scope, users, journeys, and non-goals.
- `docs/architecture.md` for system boundaries and deployment shape.
- `docs/domain-model.md` for terminology and invariants.
- `docs/integrations.md` for provider contracts and webhook rules.
- `docs/implementation-plan.md` for delivery order and acceptance criteria.
- `docs/testing-strategy.md` for test layers, scenarios, and the coverage ratchet.
- `docs/decisions/` for architecture decisions, including pinned stack versions.
- `docs/plans/` for the detailed plan of the current phase.
- `docs/research/` for verified provider and tooling findings.

If code and documentation disagree, stop and make the conflict explicit. Do not silently reinterpret the domain model.

## Product and architecture principles

1. Keep the public product repository-centric. Say “repository” in the UI unless a broader term is genuinely needed.
2. Use the internal `Resource` abstraction to avoid coupling the core domain to GitHub repositories. Do not build a generic resource platform in v1.
3. Keep `Subscription`, `Entitlement`, and `Grant` distinct:
   - a subscription is commercial state;
   - an entitlement is desired access;
   - a grant is observed provider state.
4. Treat external events as hints to recompute desired state, not commands to mutate access directly.
5. Make webhook ingestion, jobs, workflows, and provider mutations idempotent. Queue delivery is at least once.
6. Reconcile desired state against observed provider state. Include scheduled full reconciliation as a repair path.
7. Keep GitHub sign-in separate from GitHub App installations. A user identity is not a workspace connection.
8. Put GitHub and Paddle behind adapter boundaries. Provider-specific behavior belongs in integrations, not the domain.
9. Model provider capabilities explicitly. Do not pretend GitHub, GitLab, and future providers behave identically.
10. Keep Cloudflare-specific code at deployable and infrastructure edges. The domain must remain portable and testable without Cloudflare.
11. Build a SaaS architecture and launch privately. Preserve a path to self-hosting, but do not productize self-hosting yet.
12. Prefer the smallest sufficient system. Do not add Durable Objects, a separate API framework, Turborepo, or microservices without a demonstrated need.

## Intended stack

- TypeScript in strict mode
- React Router on Cloudflare Workers
- React, Tailwind CSS, and React Aria Components
- Cloudflare D1 with Drizzle
- Better Auth
- Zod at all external boundaries
- Cloudflare Queues, Workflows, and Cron Triggers
- pnpm workspaces, Vite, Wrangler, and Biome
- Vitest with the Workers test pool, plus Playwright for critical journeys
- GitHub Actions for CI and deployment

Confirm currently compatible package versions before scaffolding. Record version-sensitive choices in the repository rather than relying on this handoff.

## Working conventions

- Prefer explicit domain functions and small adapters over framework-driven business logic.
- Validate untrusted payloads before they enter the domain.
- Persist raw external event metadata and a stable provider event ID before acknowledging a webhook.
- Enforce invariants with database foreign keys, checks, and unique constraints as well as application code.
- Never log access tokens, webhook secrets, private keys, complete webhook payloads containing personal data, or decrypted tenant credentials.
- Store ShareRepo-owned secrets in Cloudflare secrets. Store tenant credentials as encrypted, versioned envelopes; keep the master key outside D1.
- All state-changing operations must produce an audit event with correlation identifiers.
- Use UTC instants in storage and make time-dependent policy explicit and testable.
- Prefer migrations that can be applied safely to a running multi-tenant service.
- Keep workspace scoping visible in queries and authorization checks. Cross-workspace access is a critical defect.

## Verification expectations

Every change should run the narrowest relevant checks and, before merge, the complete repository checks. Once Phase 0 establishes scripts, the expected baseline is:

```sh
pnpm lint
pnpm typecheck
pnpm test:coverage   # tests + coverage; commit any raised thresholds in coverage-thresholds.json
pnpm test:e2e
```

Coverage never decreases. Committed per-package thresholds only go up (≥ 90% floors; `packages/domain` near 100% plus a mutation score); see `docs/decisions/0005-coverage-ratchet.md`. Local setup and every command are in `docs/local-setup.md`.

Add tests for:

- duplicate and out-of-order webhooks;
- repeated queue delivery and workflow retries;
- entitlement/grant drift in both directions;
- workspace isolation and authorization;
- provider rate limits, transient errors, and pending invitations;
- cancellation timing, grace periods, and reactivation;
- audit completeness without secret leakage.

## Change discipline

- Work in the dependency order in `docs/implementation-plan.md`.
- Keep the suite green after each phase.
- Do not implement speculative providers to “prove” an interface. Prove the boundary with GitHub and test doubles first.
- Record a short architecture decision when changing a core boundary or invariant.
- Flag unresolved product or provider constraints rather than burying them in implementation details.

