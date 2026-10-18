# ShareRepo stack: current versions and compatibility (researched 2026-10-18)

Method: npm registry (`npm view <pkg> version time peerDependencies engines dist-tags --json`), extracted package tarballs (`npm pack`) to read shipped type declarations and source, official docs, and GitHub changelogs and issues. I also ran a local experiment (a throwaway project outside the repo): a root Vitest `projects` config with one Node project and one Workers project, run under Vitest 4.1.12 and 5.0.5 with both coverage providers. Anything marked **UNVERIFIED** was not confirmed against a primary source or by running it.

## Versions

| Package | Latest stable | Released | Key peers / engines | Source |
|---|---|---|---|---|
| vitest | 5.0.5 (v4 line: 4.1.12) | 2026-10-15 (4.1.12: 2026-10-15) | node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; vite `^6.4 \|\| ^7 \|\| ^8` | https://www.npmjs.com/package/vitest |
| @vitest/coverage-istanbul / -v8 | 5.0.5 (4.1.12) | 2026-10-15 | exact-match vitest | https://www.npmjs.com/package/@vitest/coverage-istanbul |
| **@cloudflare/vitest-plugin** (new name) | 1.4.4 | 2026-10-16 | vitest `^4.1.0 \|\| ^5.0.0`; deps pin wrangler 4.151.1 and miniflare 5.20261012.1-beta | https://www.npmjs.com/package/@cloudflare/vitest-plugin |
| @cloudflare/vitest-pool-workers (**deprecated**) | 0.23.0 | 2026-10-07 | vitest `^4.1.0` only | npm deprecation message: "renamed to @cloudflare/vitest-plugin. This package will not receive future updates." |
| @cloudflare/vite-plugin | 1.64.0 | 2026-10-14 | vite `^6.1 \|\| ^7 \|\| ^8`; wrangler `^4.151.0` | https://www.npmjs.com/package/@cloudflare/vite-plugin |
| wrangler | 4.151.1 | 2026-10-16 | node `>=22.0.0`; peer @cloudflare/workers-types `^5.20261006.1` | https://www.npmjs.com/package/wrangler |
| @cloudflare/workers-types | 5.20261018.1 | 2026-10-18 | n/a | https://www.npmjs.com/package/@cloudflare/workers-types |
| react-router / @react-router/dev | 8.4.0 | 2026-09-15 | node `>=22.22.0`; react `>=19.2.7`; vite `^7 \|\| ^8`; wrangler `^4` (optional); typescript `^5.1 \|\| ^6 \|\| ^7` (optional) | https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v800 |
| react / react-dom | 19.3.1 | 2026-10-14 | n/a | https://www.npmjs.com/package/react |
| vite | 8.3.4 | 2026-10-08 | node `^20.19.0 \|\| >=22.12.0` | https://www.npmjs.com/package/vite |
| drizzle-orm | 0.45.4 (`rc` tag: 1.0.0-rc.4) | 2026-10-08 | optional peer @cloudflare/workers-types `>=4` | https://www.npmjs.com/package/drizzle-orm |
| drizzle-kit | 0.31.11 (`rc` tag: 1.0.0-rc.4) | 2026-09-21 | n/a | https://www.npmjs.com/package/drizzle-kit |
| better-auth | 1.7.10 | 2026-10-15 | drizzle-orm `^0.45.2 \|\| >=1.0.0-rc.1 <2`; vitest `^2..^5`; zod dep `^4.5.4`; kysely dep `^0.28.17 \|\| ^0.29.0` | https://www.npmjs.com/package/better-auth |
| zod | 4.6.7 | 2026-10-12 | n/a | https://www.npmjs.com/package/zod |
| tailwindcss / @tailwindcss/vite | 4.3.3 | 2026-07-16 | @tailwindcss/vite: vite `^5.2 \|\| ^6 \|\| ^7 \|\| ^8` | https://www.npmjs.com/package/tailwindcss |
| react-aria-components | 1.22.1 | 2026-10-09 | react `^16.8 .. ^19` | https://www.npmjs.com/package/react-aria-components |
| @biomejs/biome | 2.5.15 | 2026-09-30 | node `>=14.21.3` | https://www.npmjs.com/package/@biomejs/biome |
| @playwright/test | 1.64.1 | 2026-10-14 | node `>=20` | https://www.npmjs.com/package/@playwright/test |
| fast-check | 4.10.2 | 2026-09-19 | node `>=12.17.0` | https://www.npmjs.com/package/fast-check |
| @stryker-mutator/core / vitest-runner | 10.0.0 | 2026-08-14 | node `>=22.0.0`; vitest `>=2.0.0` | https://github.com/stryker-mutator/stryker-js/blob/master/packages/vitest-runner/CHANGELOG.md |
| typescript | 7.0.2 (latest 6.x: 6.0.3, 2026-04-16) | 2026-07-08 | node `>=16.20.0` | https://www.npmjs.com/package/typescript |
| msw / @msw/cloudflare | 3.0.3 / 0.2.0 | 2026-10-10 / 2026-09-28 | @msw/cloudflare: msw `>=3` | https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/ |

**Node requirement for the whole stack:** Node **22.22.0 or later** (React Router 8 sets the floor), or Node 24 LTS. Vitest requires `^22.12 || ^24 || >=26`, and wrangler and Stryker require `>=22`. Pin the version in `.nvmrc` or `engines`. The local machine used for this research runs Node 22.17.0, which is below React Router's floor.

## Answers

### 1. Workers Vitest integration: Vitest support, configuration, mixed projects

- **The package was renamed.** On 2026-08-19, `@cloudflare/vitest-pool-workers` became **`@cloudflare/vitest-plugin`** (v1.x). The old package is deprecated on npm and its README says it "will not receive future updates". Use `@cloudflare/vitest-plugin`. A codemod handles the migration: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`.
  Sources: https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ and https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/
- **Supported Vitest versions:** `@cloudflare/vitest-plugin@1.4.4` peers on `vitest: ^4.1.0 || ^5.0.0`. Vitest 5 support was added in 1.4.0 (workers-sdk PR #16132). The deprecated `vitest-pool-workers@0.23.0` supports only `^4.1.0`. Vitest 2 and 3 support was dropped in pool-workers 0.13.0. The docs install command is `pnpm add -D vitest@^4.1.0 @cloudflare/vitest-plugin`.
  Sources: npm peers; https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md (1.4.0, 0.13.0); https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/
- **Configuration:** `defineWorkersConfig` and `defineWorkersProject` were removed in 0.13.0. Configuration now uses the `cloudflareTest()` Vite plugin together with plain `defineConfig` or `defineProject` from `vitest/config`:
  ```ts
  import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
  import { defineProject } from "vitest/config";
  export default defineProject(async () => ({
    plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } } })],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  }));
  ```
  The options are `main`, `wrangler.{configPath,environment}`, `miniflare` (with auxiliary `workers`), `remoteBindings`, `additionalExports`, and `experimental.newConfig`. Passing an async function gives access to `inject` for values from `globalSetup`. `cloudflarePool()` is also exported. Custom Vitest `environment` and `runner` settings are not supported.
  Sources: tarball `dist/pool/index.d.mts`; https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/; Cloudflare's own fixture https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples (root `vitest.config.ts` uses `test.projects: ["*/vitest.*config.*ts"]`).
- **Mixing a Node-pool project and a Workers project in one run: yes, verified.** The Cloudflare docs do not state this, so I tested it locally. A root `test.projects: ["node/vitest.config.ts", "worker/vitest.config.ts"]` config, where only the worker project uses `cloudflareTest()`, ran both projects in one `vitest run`. The Node test saw `process.versions.node` and the workers tests ran with D1 and a queue. Tested on Vitest 4.1.12 and 5.0.5 with plugin 1.4.4. Root-level `coverage` merged results from both projects.

### 2. Coverage

- **This has changed: V8 coverage is now supported.** `@cloudflare/vitest-plugin` 1.4.0 (2026-10-08, PR #15591) says: "Support V8 code coverage in the Workers Vitest integration. Vitest's default V8 coverage provider now collects and reports coverage for tests running locally in the Workers runtime." Version 1.4.3 fixed a V8 coverage teardown failure on Vitest 5.0.4 (PR #16248).
- **Istanbul is still supported.**
- **The docs are stale.** The known-issues page still says "Native code coverage via V8 is not supported" (https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/).
- **Verified locally:** with plugin 1.4.4 on Vitest 4.1.12 and 5.0.5, both `istanbul` and `v8` reported per-file coverage for `worker/src/index.ts` (Workers project) and `node/src/add.ts` (Node project) in one merged report.
- V8 coverage on the plugin is only about 10 days old. Istanbul is the lower-risk default; switch to V8 if you need its speed or accuracy.

### 3. `cloudflare:test` helpers and isolation (plugin 1.4.4, `types/cloudflare-test.d.ts`)

- **D1:** In Node (the config file), `readD1Migrations(pathOrOptions)` is exported from `@cloudflare/vitest-plugin`. It accepts `{ migrationsDir, migrationsPattern }` for nested layouts such as Drizzle's `0001_init/migration.sql`, matching Wrangler's discovery (changelog PR #15707). Inside the runtime, `applyD1Migrations(db, migrations, tableName = "d1_migrations")` comes from `cloudflare:test`. The usual pattern is to pass migrations through a `miniflare.bindings` entry and apply them in a `setupFiles` file. Verified locally.
- **Queues:** `createMessageBatch(queueName, messages[{id,timestamp,attempts,body}])` and `getQueueResult(batch, ctx)` return `{ outcome, ackAll, retryBatch, explicitAcks, retryMessages }`. Use them with `createExecutionContext()` and `waitOnExecutionContext()`. Verified locally: `explicitAcks` returned `["m1"]`.
- **Scheduled/cron:** `createScheduledController({ scheduledTime?, cron? })`, then call `worker.scheduled(controller, env, ctx)` directly.
- **Workflows:** `introspectWorkflowInstance(binding, instanceId)` and `introspectWorkflow(binding)`. Both are available from plugin 1.0.0. Introspecting Workflows exposed through `ctx.exports` needs 1.3.0 or later. Instance introspectors provide `modify(fn)` (a `WorkflowInstanceModifier` that can mock step results, errors, or timeouts, or disable sleeps), `waitForStepResult({name,index})`, `waitForStatus(status)`, `getOutput()`, `getError()`, `dispose()`, and `Symbol.asyncDispose`. `introspectWorkflow(...).get()` is async. **Dispose every introspector** (`await using` or `dispose()`), or instance state leaks into later tests. A Workflow binding is still required.
  Source: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- **Outbound fetch mocking:** `fetchMock` was **removed** from `cloudflare:test` in pool-workers 0.13.0. It is absent from the 0.23.0 and plugin 1.4.4 type declarations. The 0.20.0 release also removed the `miniflare.fetchMock` option ("use `outboundService` instead"). **The recommended replacement is MSW**: `msw@^3` plus `@msw/cloudflare`, using `network.enable()` in a `setupFiles` file, `network.resetHandlers()` in `afterEach`, and `network.use(...)` in tests. Alternatives are spying on `globalThis.fetch` or a Miniflare `outboundService`.
  Sources: https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/ and the vitest-plugin CHANGELOG (0.13.0, 0.20.0).
- **Other changes:** `env` and `SELF` from `cloudflare:test` are deprecated. Use `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()`, which does not serve Assets. Also available: `reset()` (deletes all binding data), `abortAllDurableObjects()`, `evictAllDurableObjects()`, `adminSecretsStore()`, and `listDurableObjectIds()`.
- **Storage isolation is per test file, not per test.** `isolatedStorage` and `singleWorker` were removed in 0.13.0. Each file has its own storage and writes are reverted at the end of the file. Test files run concurrently. To share storage across files, run with `--max-workers=1 --no-isolate`. Tests within one file share state, so use `reset()` in `afterEach` or unique IDs per test. Verified locally: data written in `a.test.ts` was not visible in `b.test.ts`.
  Source: https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/

### 4. `coverage.thresholds.autoUpdate` with a function

Yes, it accepts a function. The type is `boolean | ((newThreshold: number) => number)` from **Vitest 4.0.0**. Vitest 3.0.9, 3.1.0, and 3.2.4 accept only `boolean`. In **Vitest 5.0.0** the function also receives the previous value: `(newThreshold: number, previousThreshold: number) => number`. The docs example is `autoUpdate: (n) => Math.floor(n)`. It is available for both v8 and istanbul. The docs page has no version badge, so the version comes from inspecting the shipped `.d.ts` files of vitest 3.0.9, 3.1.0, 3.2.4, 4.0.0, 4.1.12, 5.0.0, and 5.0.5.
Source: https://vitest.dev/config/coverage

### 5. Better Auth 1.7.10

- **D1 support:** native since 1.5 (https://better-auth.com/blog/1-5). Passing the binding directly as `database: env.DB` is auto-detected. `@better-auth/kysely-adapter@1.7.10` ships its own D1 dialect and a D1-specific introspector, so the external `kysely-d1` package is not needed. Because the binding is only available per request, build the `betterAuth()` instance per request or lazily from `env`.
- **Drizzle path:** `better-auth/adapters/drizzle` with `drizzleAdapter(db, { provider: "sqlite", schema })`. It peers on `drizzle-orm ^0.45.2`, which is compatible. This keeps one schema and migration source (drizzle-kit) for auth tables too. It is the recommended path for ShareRepo; this is my inference.
- **Gotcha:** 1.7.3 added per-request runtime schema validation (`advanced.database.validateSchema`, default `true`). On D1 through Kysely this broke every request with `SQLITE_AUTH` because of `sqlite_master` reads (issue #11346, closed 2026-09-23). 1.7.10 ships a D1-safe introspector. The type docs say "Drizzle and Prisma inspect local schema metadata without opening a connection", so the Drizzle adapter avoids the problem entirely. Keep `validateSchema` in mind if requests fail. https://github.com/better-auth/better-auth/issues/11346
- **Can the GitHub provider endpoints be overridden? No.** In `@better-auth/core@1.7.10` `dist/social-providers/github.mjs`, the authorize URL (`https://github.com/login/oauth/authorize`), token URL (`https://github.com/login/oauth/access_token`), and `https://api.github.com/user` and `/user/emails` are hardcoded. Only `getUserInfo`, `refreshAccessToken`, `mapProfileToUser`, `scope`, `disableDefaultScope`, `prompt`, and `redirectURI` can be overridden.
- **Can genericOAuth point at a local fake server? Yes.** `better-auth/plugins/generic-oauth` accepts `authorizationUrl`, `tokenUrl`, `userInfoUrl` (or `discoveryUrl`), `getToken`, `getUserInfo`, `mapProfileToUser`, `pkce`, `providerId`, and more, so it can target a local fake OAuth server in E2E. **Caveat:** it is a different flow. Clients call `signIn.oauth2({ providerId })` instead of `signIn.social({ provider: "github" })`, and the callback path is `/oauth2/callback/:providerId`. Production and E2E would exercise different code paths, and `account.providerId` values would differ unless you use `providerId: "github"` in the test build only and drop the social provider there. **UNVERIFIED:** whether `providerId: "github"` in genericOAuth collides with the built-in social provider ID when both are registered.
- **Other E2E options:** override `getUserInfo` and intercept the token exchange at the network layer, or put a fake GitHub behind a host-level redirect. The first option is unit-test friendly. For Playwright against the real Worker, a genericOAuth-based fake is the cleanest; this is my inference.

### 6. Drizzle with D1

- **`db.batch()` is supported for D1.** `drizzle-orm@0.45.4` `d1/driver.d.ts` declares `batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>`. The Drizzle batch docs page only mentions Neon HTTP, but the D1 driver has it. D1 semantics: "Batched statements are SQL transactions. If a statement in the sequence fails ... it aborts or rolls back the entire sequence." D1 has **no interactive transactions**, so `batch()` is the only atomic multi-statement tool.
  Source: https://developers.cloudflare.com/d1/worker-api/d1-database/
- **Migrations workflow:** use `drizzle-kit generate` (dialect `sqlite`) to write SQL into a folder, set `migrations_dir` in `wrangler.jsonc` to that folder, and run `wrangler d1 migrations apply <db> --local|--remote`. In tests, `readD1Migrations` plus `applyD1Migrations` reads the same folder. Wrangler 4.151 also supports `migrations_pattern`, which must start with `${migrations_dir}/`, for nested layouts.
  **UNVERIFIED:** I did not generate migrations with drizzle-kit 0.31.11. My understanding is that it writes a flat `NNNN_name.sql` plus `meta/_journal.json`, and wrangler applies only the `*.sql` files. drizzle-kit 1.0 rc uses a nested `<ts>_name/migration.sql` layout, which is the reason `migrationsPattern` exists.
- **Versions:** drizzle-kit `latest` is 0.31.11 and drizzle-orm `latest` is 0.45.4. **However, the Drizzle D1 docs page now tells you to install `drizzle-orm@rc` and `drizzle-kit@rc` (1.0.0-rc.4)** (https://orm.drizzle.team/docs/connect-cloudflare-d1). Decide deliberately: 0.45 is the stable `latest`, and better-auth peers on both `^0.45.2` and `>=1.0.0-rc.1`.

### 7. React Router and the Cloudflare Vite plugin

- react-router and @react-router/dev are at **8.4.0** (v8.0.0 was released 2026-06-17). @cloudflare/vite-plugin is at **1.64.0**. They are compatible: the Cloudflare plugin peers on `vite ^6.1 || ^7 || ^8` and React Router 8 requires Vite 7 or later. Use **Vite 8.3.4**.
- React Router v8 requires **Node 22.22.0 or later, React 19.2.7 or later, and Vite 7 or later**. It **removed `@react-router/dev/vite/cloudflare`**; use `@cloudflare/vite-plugin` instead. It also removed `react-router-dom`, and middleware, split route modules, and the Vite Environment API are now always on.
  Source: https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v800
- `@cloudflare/vite-plugin@1.64.0` peers on `wrangler ^4.151.0`, so use wrangler 4.151.x. This also matches `@cloudflare/vitest-plugin@1.4.4`, which pins wrangler 4.151.1.

### 8. Stryker with Vitest

- `@stryker-mutator/vitest-runner@10.0.0` declares the peer `vitest >=2.0.0`, but **it is broken on Vitest 5**. Open issue **#6210** (since 2026-09-04): Vitest 5 changed `testNamePattern` to match the full chain joined by `" > "`, while the runner joins names with a space. Every mutant with per-test coverage runs zero tests and is reported as Survived. Reports describe the score collapsing, for example from 47% to 3%, and the problem is confirmed on Vitest 5.0.0 through 5.0.4. A fix PR (#6214) exists but is not released. Issue **#6258**: `logLevel: "debug"` crashes `init()` on Vitest 5.
  Sources: https://github.com/stryker-mutator/stryker-js/issues/6210 and https://github.com/stryker-mutator/stryker-js/issues/6258
- Vitest 4.1 is supported. 9.4.0 added Vitest 4 support and 9.6.1 fixed hit counts and coverage for 4.1.
- The runner **forces `pool: 'threads'`** (in `dist/src/vitest-test-runner.js`), so it must not run against the Workers-pool project. Using it on a pure Node package is fine (see also open issue #6236 about `execArgv`).

### 9. Other versions

These are in the table above: Biome 2.5.15, Playwright 1.64.1, Tailwind 4.3.3 (with `@tailwindcss/vite` 4.3.3), React Aria Components 1.22.1, Zod 4.6.7, fast-check 4.10.2, wrangler 4.151.1, and TypeScript 7.0.2 (latest 6.x is 6.0.3).

## Gotchas

1. **Do not install `@cloudflare/vitest-pool-workers`.** It is deprecated; use `@cloudflare/vitest-plugin@^1.4.4`. Most blog posts and older docs still reference the old package name and `defineWorkersConfig`.
2. **Pin Vitest to 4.1.x across the repo** (4.1.12, with matching `@vitest/coverage-*@4.1.12`). The Workers plugin supports Vitest 5, but Stryker's vitest-runner is silently wrong on Vitest 5 (#6210). With pnpm workspaces, a single Vitest version avoids duplicate-instance problems; the plugin's `inject` typings even mention "If pnpm resolves a separate Vitest copy". Revisit once Stryker ships the #6214 fix. On 4.1, `autoUpdate` receives only `newThreshold`, which is enough for rounding.
3. **The Cloudflare docs contradict the changelog on V8 coverage.** The known-issues page says V8 is unsupported, but plugin 1.4.0 and later support it, and it worked in my test. Istanbul is the conservative choice.
4. **Storage isolation is per file, not per test.** Tests in the same file share D1 state. Use `reset()` in `afterEach` or per-test unique workspace IDs. That also exercises workspace scoping, which is useful.
5. **`fetchMock` is gone.** Use `msw@^3` and `@msw/cloudflare`; note that msw 3 peers on `typescript >=5.9`.
6. **Docs and package exports disagree.** The test-APIs and migration docs reference `@cloudflare/vitest-plugin/config` for `readD1Migrations`, but `@cloudflare/vitest-plugin@1.4.4`'s `package.json` `exports` only has `.` and `./types`. Import `readD1Migrations` and `cloudflareTest` from the package root. This is the form Cloudflare's own fixtures use.
7. **The plugin depends on a pre-release Miniflare.** `@cloudflare/vitest-plugin@1.4.4` pins `miniflare@5.20261012.1-beta` and `wrangler@4.151.1` as hard dependencies, while miniflare's `latest` tag is still 4.x. Lockfile churn is expected; align your wrangler with 4.151.1 to avoid two copies.
8. **TypeScript 7.0 is the native (Go) compiler.** The `typescript@7.0.2` package `exports["."]` is only `./lib/version.cjs`, and the API is under `typescript/unstable/*`. Any tool that does `import ts from "typescript"` and uses the classic compiler API will break; this is inferred from the exports map. Examples could include Stryker's `@stryker-mutator/typescript-checker`, some Vite and ESLint-style plugins, and possibly drizzle-kit config loading. **UNVERIFIED per tool.** React Router 8.4 peers on TS `^7`. The safe choice is **TypeScript 6.0.3** until each tool is checked; TS 7's `tsc` could be used only for `pnpm typecheck` if desired.
9. **`@cloudflare/workers-types` major mismatch.** wrangler 4.151 peers on `@cloudflare/workers-types ^5`, while `@react-router/cloudflare@8.4.0` peers on `^4`. With `@cloudflare/vite-plugin` you generally don't need `@react-router/cloudflare`; prefer `wrangler types`-generated runtime types (inference).
10. **Node version:** use Node 22.22 or later, or Node 24 (React Router 8 floor). Node 22.17, which this machine has, does not satisfy React Router 8.
11. **pnpm 10 blocks `workerd` and `esbuild` postinstall scripts by default** ("Ignored build scripts: esbuild, workerd"). My test still passed without approving them, but add them to `pnpm.onlyBuiltDependencies` explicitly to be safe.
12. **Drizzle docs now push `@rc` (1.0).** Stable `latest` is still 0.45.4 / 0.31.11. Choose one deliberately and record it. 1.0's nested migration layout needs `migrations_pattern` in wrangler and `migrationsPattern` in `readD1Migrations`.
13. **D1 has no interactive transactions.** Drizzle `db.transaction()` will not work on D1; multi-statement invariants must use `db.batch()`. Better Auth's D1 dialect also throws on transactions.
14. **Better Auth GitHub endpoints are hardcoded.** A fake OAuth server for E2E needs genericOAuth or network-level interception, and genericOAuth uses a different sign-in API and callback path from `signIn.social`. Decide whether E2E should cover the real social flow.
15. **Stryker forces the `threads` pool.** Never point it at the Workers project; give the domain package its own Node-only Vitest config.
