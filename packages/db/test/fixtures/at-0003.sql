-- Representative rows for a database at migration 0003 (resync versions and outbox failures).
-- Loaded by upgrade.test.ts after migrations 0000..0003; every later migration must keep them.
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

INSERT INTO connection_intents (id, workspace_id, user_id, token_hash, write_access_acknowledged_at, created_at, expires_at, consumed_at) VALUES
  ('ci1', 'w1', 'u1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1760000000000, 1760000000000, 1760000600000, 1760000060000),
  ('ci2', 'w1', 'u2', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1760086400000, 1760086400000, 1760087000000, NULL);

INSERT INTO connections (id, workspace_id, provider, installation_id, account_external_id, account_login_snapshot, account_type, status, permissions, write_access_acknowledged_at, created_by_user_id, created_at, updated_at, last_synced_at, sync_version, sync_token) VALUES
  ('c1', 'w1', 'github', '42', '1001', 'alice', 'user', 'active', '{"administration":"write","metadata":"read"}', 1760000000000, 'u1', 1760000000000, 1760086400000, 1760086400000, 4, NULL),
  ('c2', 'w2', 'github', '43', '1001', 'alice', 'user', 'suspended', '{}', 1760003600000, 'u1', 1760003600000, 1760259200000, NULL, 1, 'sync-tok-2');

INSERT INTO resources (id, workspace_id, connection_id, external_id, name_snapshot, selection, discovered_at, updated_at, provider, type, owner_external_id, private, archived, capabilities) VALUES
  ('r1', 'w1', 'c1', '5001', 'alice/engine', 'selected', 1760000000000, 1760086400000, 'github', 'repository', '1001', 1, 0, '{"invitations":true}'),
  ('r2', 'w1', 'c1', '5002', 'alice/old-docs', 'removed', 1760000000000, 1760172800000, 'github', 'repository', '1001', 1, 1, '{"invitations":true}'),
  ('r3', 'w2', 'c2', '5003', 'alice/beta', 'selected', 1760003600000, 1760003600000, 'github', 'repository', '1001', 1, 0, '{"invitations":true}');

INSERT INTO external_events (id, provider, external_event_id, event_type, action, installation_id, last_error_code, processed_at, payload_digest, received_at, processing_state, attempts) VALUES
  ('e1', 'github', 'gh-delivery-1', 'installation', 'created', '42', NULL, 1760000001000, 'sha256:1111111111111111111111111111111111111111111111111111111111111111', 1760000000000, 'processed', 1),
  ('e2', 'github', 'gh-delivery-2', 'installation_repositories', 'added', '42', 'transient', NULL, 'sha256:2222222222222222222222222222222222222222222222222222222222222222', 1760086400000, 'failed', 3),
  ('e3', 'github', 'gh-delivery-3', 'ping', NULL, NULL, NULL, NULL, 'sha256:3333333333333333333333333333333333333333333333333333333333333333', 1760172800000, 'ignored', 0);

INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, sent_at, failed_at, last_error_code) VALUES
  ('o1', 'process_external_event', 'e1', 1760000000000, 1760000000000, 1, 1760000000500, NULL, NULL),
  ('o2', 'resync_connection', 'c1', 1760086400000, 1760090000000, 0, NULL, NULL, NULL),
  ('o3', 'process_external_event', 'e2', 1760086400000, 1760086405000, 5, NULL, 1760086409000, 'transient');
