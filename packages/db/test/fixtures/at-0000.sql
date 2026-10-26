-- Representative rows for a database at migration 0000 (init).
-- Loaded by upgrade.test.ts after migrations 0000..0000; every later migration must keep them.
-- Every table that exists at this migration has at least one row, and every row satisfies the
-- constraints and triggers of this migration. One statement per `;` at the end of a line.

INSERT INTO users (id, created_at, updated_at) VALUES
  ('u1', 1760000000000, 1760000000000),
  ('u2', 1760003600000, 1760007200000),
  ('u3', 1760007200000, 1760007200000);

INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
  ('w1', 'acme', 'Acme', 'active', 1760000000000, 1760086400000),
  ('w2', 'beta-tools', 'Beta Tools', 'suspended', 1760003600000, 1760259200000);

INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES
  ('w1', 'u1', 'owner', 1760000000000),
  ('w1', 'u2', 'member', 1760007200000),
  ('w2', 'u1', 'owner', 1760003600000);
