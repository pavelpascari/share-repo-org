# Runbook — backup and restore (D1)

ShareRepo keeps all durable state in one D1 database per environment (`sharerepo-dev`, `sharerepo-prod`). This runbook covers what protects it, the drill that rehearses a restore, and a real restore with its order of operations. Background: [cloudflare-durability.md](../research/cloudflare-durability.md) § 3 (D1), [decision 0015](../decisions/0015-data-lifecycle.md) (purges and the 30-day window), and [incident response](incident-response.md) § Restoring D1 for what a restore loses.

**Status:** Phase 6 T7. The drill runs locally and is tested (`scripts/test/db-drill.test.ts`). The remote export and both restore paths have not been run against a deployed environment yet; do that in dev before the founder launch (a first-deploy check in [deployment](../deployment.md)).

## What needs protecting

| State | Where | Protected by |
|---|---|---|
| Workspaces, access, subscriptions, audit history, outbox | D1 | Time Travel (30 days); exports |
| Messages in flight | `sharerepo-events-*` and its dead-letter queue | Nothing needed: the outbox row is the record, and the drain re-sends unsent rows ([decision 0003](../decisions/0003-d1-batches-and-transactional-outbox.md)) |
| ShareRepo secrets, master keys | Cloudflare secrets, and the password manager | The password manager |

A backup of D1 is useless without the keys that sealed its envelopes. `CREDENTIAL_KEYS` lives outside D1 (decision 0011). If you restore to a point before a [`rewrap_credentials`](secret-rotation.md) run finished, the restored envelopes are under the **old** key again. **Keep a retired master key in the password manager for at least 30 days after it leaves the keyring**, so any restore point Time Travel can reach can still be opened. The same holds for a retired `CLAIM_SIGNING_KEY`: claim references and rate-limit buckets in a restored database were made under it.

## Backups

- **Time Travel** is always on. It restores to any minute in the last 30 days (Paid plan; 7 on Free), by timestamp or bookmark. A restore is **in place and destructive**: every write after the restore point is lost. There is no clone or fork. At most 10 restores per 10 minutes per database.
  - See the current bookmark: `pnpm exec wrangler d1 time-travel info sharerepo-prod --env production -c apps/web/wrangler.jsonc`. Note it in the incident log before any risky manual change.
  - `wrangler d1 migrations apply` captures a backup itself before applying.
- **Exports** (`wrangler d1 export`) are the second line, and the only one that survives a deleted database after the 7-day undelete window. `pnpm db:drill --remote --env production --keep` makes one and proves it restores (below). **A running export blocks every other request to the database**, so run it at a quiet time.
- **Retention beyond 30 days** is not set up. Cloudflare documents a Workflow that exports D1 to R2 on a schedule; ShareRepo does not need it before it has customer data worth keeping that long. Open point for the launch checklist.

## The drill: `pnpm db:drill`

```sh
pnpm db:drill                                  # the local database of `pnpm dev` (apps/web/.wrangler/state)
pnpm db:drill --persist-to .e2e/state          # the last E2E run's database, which has data in every table
pnpm db:drill --remote --env production --keep # the production database, read-only
```

It never writes to the source: a local database is copied to a scratch directory first, and a remote one is only exported. Then it:

1. exports the database (`wrangler d1 export`) to `backup.sql`;
2. writes `restore.sql`, the same statements with every `CREATE TABLE` and `CREATE INDEX` before the first `INSERT` (see below);
3. imports `restore.sql` into a fresh local D1;
4. checks that every exported row is back, table by table, and that the same indexes and triggers exist;
5. checks the `d1_migrations` table: the backup's migrations must be the first ones in `packages/db/migrations`. It applies the rest, as the next deploy would, and checks that the table then lists every migration;
6. runs `PRAGMA quick_check` (D1 refuses `integrity_check`) and `PRAGMA foreign_key_check`.

It prints a report and exits 0 when everything matches, 1 when a check fails (each difference is listed), and 2 when a step fails (with Wrangler's output). `--keep` keeps the scratch directory, with `backup.sql`, `restore.sql` and the restored database, and prints its path. Delete it when done: an export of production contains personal data.

A drill of the E2E database, on 2026-10-25:

```text
Tables: 35, rows restored: 882 (exported: 882)
Indexes (as restored): 67, triggers: 8
Migrations: 11 in the backup, 0 applied by the drill, 11 now
quick_check: ok, foreign key violations: 0
Drill passed.
```

A drill of a database at migration 0008 also applied 0009 and 0010 and passed: the drill doubles as a check that a production backup upgrades cleanly.

**Run it** before each deploy that carries a migration (`--remote` against the environment you are about to migrate), and once a month against production.

### Why `restore.sql` and not the raw export

**A D1 export cannot be imported into D1 as written.** Found by the T7 drill:

- The export lists tables in creation order. A table that a migration rebuilt comes after the tables that reference it: migration 0009 rebuilt `workspaces`, so it is now last. D1 always enforces foreign keys, and inserting a child row whose parent table does not exist yet fails with `no such table: main.workspaces`, even under `PRAGMA defer_foreign_keys`.
- The export creates indexes after the rows. A composite foreign key (decision 0004) needs its parent's unique index, so inserting the child row fails with `foreign key mismatch`.

`restore.sql` moves the schema first and keeps the rows and triggers in their exported order. The triggers stay last on purpose: `workspaces_created_live` refuses to insert a workspace that is being deleted, and a restore must bring those back.

## A real restore

Decide first, with [incident response](incident-response.md) § Restoring D1:

- **Bad data, a bad manual change, a mistaken purge, within 30 days:** Time Travel, in place.
- **The database was deleted:** undelete it within 7 days (Cloudflare dashboard or API); otherwise import the latest export into a new database.

### In place, with Time Travel

1. **Open an incident note.** Record who decided, why, and the restore point: the UTC minute before the damage. Find it from the audit events (`occurred_at`) or Workers Logs.
2. **Write down what the restore will lose** ([incident response](incident-response.md) § Restoring D1): GitHub access granted after the restore point, Paddle facts, owners' changes.
3. **Pause queue delivery**, so that no job runs half against the old and half against the restored data:

   ```sh
   pnpm exec wrangler queues pause-delivery sharerepo-events-prod
   pnpm exec wrangler queues pause-delivery sharerepo-events-dlq-prod
   ```

   The jobs Worker's crons keep running. That is safe: every job re-reads its state, and the restore cancels queries in flight.
4. **Restore:**

   ```sh
   pnpm exec wrangler d1 time-travel restore sharerepo-prod --env production -c apps/web/wrangler.jsonc --timestamp=<RFC 3339 UTC>
   ```

   It prints the bookmark from before the restore. Put it in the incident note: restoring to it undoes the restore.
5. **Bring the schema forward.** If the restore point is before the last migration, the deployed Workers expect a schema the database no longer has. `pnpm exec wrangler d1 migrations list sharerepo-prod --remote --env production -c apps/web/wrangler.jsonc`, then `pnpm db:migrate:prod` if anything is pending.
6. **Check the keys.** `CREDENTIAL_KEYS` must list every key the restored envelopes name. If a key was removed after the restore point, add it back as a non-current key, deploy both Workers, and let the daily rewrap move the envelopes again ([secret rotation](secret-rotation.md) § 1).
7. **Resume delivery** (`wrangler queues resume-delivery` for both queues), then watch `/ops`: Sweep health, failed jobs, connections. Owners' "Check now" and the minute sweep repair GitHub access; the daily Paddle sweep re-reads every subscription that changed in Paddle after the restore point.
8. **Tell affected owners** what was lost, from step 2.

### Into a new database, from an export

1. Get a drilled export: `pnpm db:drill --remote --env production --keep` (or the latest kept one). Use its `restore.sql`, never `backup.sql`.
2. `pnpm exec wrangler d1 create sharerepo-prod-restored`, and put the new `database_name` and `database_id` in the production `d1_databases` of **both** `apps/web/wrangler.jsonc` and `apps/jobs/wrangler.jsonc` ([decision 0002](../decisions/0002-one-wrangler-config-per-worker.md)).
3. Import before deploying: `pnpm exec wrangler d1 execute sharerepo-prod-restored --remote --env production -c apps/web/wrangler.jsonc --file <dir>/restore.sql`. Imports are limited to 5 GB.
4. Apply pending migrations, then run `PRAGMA quick_check` and `PRAGMA foreign_key_check` with `wrangler d1 execute … --remote --command`.
5. Deploy both Workers, then steps 6–8 above.
