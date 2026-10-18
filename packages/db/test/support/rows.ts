import { env } from "cloudflare:workers";

// D1 storage is shared by all tests in a file, so every test uses fresh identifiers.
export const uniqueId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
export const uniqueSlug = (): string => `ws-${crypto.randomUUID().slice(0, 8)}`;

export const T0 = Date.UTC(2026, 0, 1);

export interface RawWorkspace {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export function insertUserRow(id = uniqueId("usr"), createdAt = T0, updatedAt = createdAt) {
  return env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(id, createdAt, updatedAt)
    .run();
}

export function insertWorkspaceRow(overrides: Partial<RawWorkspace> = {}) {
  const row: RawWorkspace = {
    id: uniqueId("ws"),
    slug: uniqueSlug(),
    name: "Acme",
    status: "active",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
  return env.DB.prepare(
    "INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.slug, row.name, row.status, row.created_at, row.updated_at)
    .run();
}

export function insertMembershipRow(workspaceId: string, userId: string, role = "member") {
  return env.DB.prepare(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(workspaceId, userId, role, T0)
    .run();
}
