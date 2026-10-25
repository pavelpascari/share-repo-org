-- Representative rows for a database at migration 0001 (identity and audit).
-- Loaded by upgrade.test.ts after migrations 0000..0001; every later migration must keep them.
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

INSERT INTO auth_users (id, name, email, email_verified, image, created_at, updated_at) VALUES
  ('u1', 'Alice', 'alice@example.test', 1, NULL, 1760000000000, 1760000000000),
  ('u2', 'Bob', 'bob@example.test', 0, 'https://avatars.example.test/2', 1760003600000, 1760003600000);

INSERT INTO auth_accounts (id, user_id, provider_id, account_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at) VALUES
  ('aa1', 'u1', 'github', '1001', NULL, NULL, NULL, NULL, NULL, 'read:user', NULL, 1760000000000, 1760000000000),
  ('aa2', 'u2', 'github', '1002', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1760003600000, 1760003600000);

INSERT INTO auth_sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at) VALUES
  ('as1', 'u1', 'session-token-1', 1760604800000, '203.0.113.1', 'test', 1760000000000, 1760000000000),
  ('as2', 'u2', 'session-token-2', 1759913600000, NULL, NULL, 1759308800000, 1759308800000);

INSERT INTO auth_verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES
  ('av1', 'github-state-1', '{}', 1760000600000, 1760000000000, 1760000000000);

INSERT INTO auth_rate_limits (id, key, count, last_request) VALUES
  ('arl1', '203.0.113.1/sign-in/social', 3, 1760000000000);

INSERT INTO external_identities (id, user_id, provider, external_user_id, username_snapshot, display_name_snapshot, avatar_url_snapshot, verified_at, created_at, updated_at) VALUES
  ('ei1', 'u1', 'github', '1001', 'alice', 'Alice', NULL, 1760000000000, 1760000000000, 1760000000000),
  ('ei2', 'u2', 'github', '1002', 'bob', NULL, 'https://avatars.example.test/2', 1760003600000, 1760003600000, 1760086400000);

INSERT INTO audit_events (id, scope, workspace_id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, occurred_at, details) VALUES
  ('ae1', 'workspace', 'w1', 'user', 'u1', 'workspace.created', 'workspace', 'w1', NULL, 'cor1', 1760000000000, '{"slug":"acme"}'),
  ('ae2', 'account', NULL, 'user', 'u2', 'user.signed_in', 'user', 'u2', NULL, 'cor2', 1760003600000, '{}'),
  ('ae3', 'workspace', 'w2', 'operator', 'u1', 'workspace.suspended', 'workspace', 'w2', 'abuse report', 'cor3', 1760259200000, '{}'),
  ('ae4', 'account', NULL, 'system', NULL, 'user.created', 'user', 'u3', NULL, 'cor4', 1760007200000, '{}');
