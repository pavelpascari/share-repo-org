# 0004 — Workspace-scoped composite foreign keys

**Status:** Proposed

## Context

Domain invariant 2 says relations between tenant-owned records never cross workspace boundaries. Application checks alone can be bypassed by a bug in one query. SQLite (and therefore D1) enforces foreign keys and supports composite keys.

## Decision

- Every tenant-owned table has a non-null `workspace_id` and a unique constraint on `(workspace_id, id)`.
- A reference from one tenant-owned table to another uses a composite foreign key: for example `grants (workspace_id, resource_id) REFERENCES resources (workspace_id, id)`. Because both rows must share `workspace_id`, the database rejects a cross-workspace link.
- Repository functions take `workspaceId` as an explicit, required argument and include it in every `WHERE` clause.

## Consequences

- Schema is slightly wider, with extra unique indexes.
- Every new tenant-owned relation needs a DB integration test proving that a cross-workspace insert fails.
- Global tables (`users`, `external_identities`) are not workspace-owned and use ordinary foreign keys.
