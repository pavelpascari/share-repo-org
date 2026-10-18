export {
  type AuditEvents,
  appendAuditEvents,
  listAuditEventsByCorrelationId,
  listAuditEventsForWorkspace,
} from "./audit-repository.ts";
export { createDb, type Db, ping } from "./client.ts";
export {
  type Connection,
  type ConnectionIntent,
  type CreateConnectionFromIntentResult,
  createConnectionFromIntent,
  createConnectionIntent,
  findConnectionByInstallationId,
  findConnectionIntentByTokenHash,
  getConnection,
  listActiveConnectionIds,
  listConnectionsForWorkspace,
  type UpdateConnectionResult,
  updateConnection,
} from "./connection-repository.ts";
export { isUniqueViolation, uniqueViolationColumns } from "./errors.ts";
export {
  type ExternalEvent,
  getExternalEvent,
  listExternalEventsByState,
  markExternalEvent,
  type NewExternalEvent,
  type RecordExternalEventResult,
  recordExternalEvent,
} from "./event-repository.ts";
export {
  type ExternalIdentity,
  type ExternalIdentitySnapshot,
  findExternalIdentity,
  findExternalIdentityForUser,
  type InsertExternalIdentityResult,
  insertExternalIdentity,
  type UpdateExternalIdentitySnapshotResult,
  updateExternalIdentitySnapshot,
} from "./identity-repository.ts";
export {
  claimOutbox,
  enqueueOutbox,
  markOutboxFailed,
  markOutboxSent,
  type NewOutboxRow,
  type OutboxRow,
  outboxInsert,
} from "./outbox-repository.ts";
export {
  type ApplyResourceSyncResult,
  applyResourceSync,
  getResource,
  listResourcesForConnection,
  listResourcesForWorkspace,
  type Resource,
  type ResourceChanges,
  type ResourceSync,
} from "./resource-repository.ts";
export * as schema from "./schema/index.ts";
export { createUser, type User } from "./user-repository.ts";
export {
  type AddWorkspaceMemberResult,
  addWorkspaceMember,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  createWorkspace,
  findWorkspaceForMemberBySlug,
  getWorkspaceForMember,
  listWorkspacesForUser,
  renameWorkspace,
  type Workspace,
  type WorkspaceForMember,
} from "./workspace-repository.ts";
