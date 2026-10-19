// Collaborators and invitations for the E2E fake GitHub App, with the same semantics as the
// in-memory fake in @sharerepo/integrations/testing:
// - a repository has direct collaborators and invitations; its owner (the installing account)
//   appears only in `affiliation=all`, as admin;
// - `PUT …/collaborators/{login}` answers 204 for a collaborator, 201 with the pending invitation
//   (the same one again while it is unexpired), and 404 for an unknown account;
// - removing a collaborator leaves invitations alone (decision 0010);
// - a repository that is renamed away or removed answers 404 everywhere.
// Lists come back as one page: the fake never holds more than 100.
//
// Test-only control routes (form-encoded bodies, as the other `/_control` routes):
// - POST /_control/repos/{owner}/{name}/collaborators          id, login, permission? → add by hand
// - POST /_control/repos/{owner}/{name}/collaborators/{userId}/remove                → remove by hand
// - POST /_control/repos/{owner}/{name}/invitations/by-user/{userId}/accept          → invitee accepts
// - POST /_control/repos/{owner}/{name}/invitations/{invitationId}/expire            → GitHub expires it
// - GET  /_control/repos/{owner}/{name}               → { collaborators, invitations } (port shapes)
// - POST /_control/failures   operation, status, retry_after?, repository? → the next call of
//   `operation` (listCollaborators, listInvitations, addCollaborator, removeCollaborator,
//   cancelInvitation, getUserById) answers with that status (429, 403, 422, 5xx…); with
//   `repository` (`owner/name`), only a call on that repository does, so parallel tests don't
//   take each other's failures
import type { IncomingMessage, ServerResponse } from "node:http";

export type Permission = "read" | "write" | "admin";

export interface Account {
  id: number;
  login: string;
  type: "User" | "Organization";
}

interface Collaborator {
  id: number;
  login: string;
  permission: Permission;
}

interface Invitation {
  id: number;
  invitee: { id: number; login: string };
  createdAt: string;
  expired: boolean;
}

interface Access {
  collaborators: Map<number, Collaborator>;
  invitations: Invitation[];
}

/** What the collaborator endpoints need from the rest of the fake App. */
export interface FakeAppState {
  /** The repositories of the installation a token belongs to, with that installation's owner. */
  repositoryFor(
    token: string,
    fullName: string,
  ): { id: number; owner: Account } | null | "unauthorized";
  /** Any installation's repository, for controls. */
  repositoryNamed(fullName: string): { id: number; owner: Account } | null;
  userByLogin(login: string): Account | undefined;
  userById(id: number): Account | undefined;
  registerUser(account: Account): void;
  isInstallationToken(token: string): boolean;
}

const OPERATIONS = new Set([
  "listCollaborators",
  "listInvitations",
  "addCollaborator",
  "removeCollaborator",
  "cancelInvitation",
  "getUserById",
]);

const PERMISSIONS: Record<Permission, Record<string, boolean>> = {
  admin: { admin: true, maintain: true, push: true, triage: true, pull: true },
  write: { admin: false, maintain: false, push: true, triage: true, pull: true },
  read: { admin: false, maintain: false, push: false, triage: false, pull: true },
};

export function createFakeCollaborators(app: FakeAppState) {
  const access = new Map<number, Access>();
  const failures = new Map<string, { status: number; retryAfter: string | null }>();
  let nextInvitationId = 8000;

  const accessOf = (repositoryId: number): Access => {
    let found = access.get(repositoryId);
    if (found === undefined) {
      found = { collaborators: new Map(), invitations: [] };
      access.set(repositoryId, found);
    }
    return found;
  };

  const userJson = (account: { id: number; login: string }) => ({
    login: account.login,
    id: account.id,
    node_id: `U_${account.id}`,
    type: "User",
    site_admin: false,
  });

  const collaboratorJson = (collaborator: Collaborator) => ({
    ...userJson(collaborator),
    permissions: PERMISSIONS[collaborator.permission],
    role_name: collaborator.permission,
  });

  const invitationJson = (invitation: Invitation, fullName: string) => ({
    id: invitation.id,
    node_id: `RI_${invitation.id}`,
    repository: { full_name: fullName },
    invitee: userJson(invitation.invitee),
    permissions: "write",
    created_at: invitation.createdAt,
    expired: invitation.expired,
  });

  const pending = (repository: Access, userId: number) =>
    repository.invitations.find(
      (invitation) => invitation.invitee.id === userId && !invitation.expired,
    );

  /** An injected failure for `operation` (on `repository`, or on any), answered once. */
  function failed(res: ServerResponse, operation: string, repository?: string): boolean {
    const scoped = repository === undefined ? undefined : `${operation} ${repository}`;
    const key = scoped !== undefined && failures.has(scoped) ? scoped : operation;
    const failure = failures.get(key);
    if (failure === undefined) return false;
    failures.delete(key);
    const headers: Record<string, string> = {};
    if (failure.retryAfter !== null) headers["retry-after"] = failure.retryAfter;
    const body =
      failure.status === 422
        ? { message: "Validation Failed", errors: [{ resource: "Repository", code: "custom" }] }
        : failure.status === 403 && failure.retryAfter === null
          ? { message: "Resource not accessible by integration" }
          : { message: "Injected failure" };
    json(res, failure.status, body, headers);
    return true;
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: string,
  ): Promise<boolean> {
    const path = url.pathname;
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");

    const userById = path.match(/^\/api\/user\/(\d+)$/);
    if (userById !== null && req.method === "GET") {
      if (!app.isInstallationToken(token)) return json(res, 401, { message: "Bad credentials" });
      if (failed(res, "getUserById")) return true;
      const user = app.userById(Number(userById[1]));
      return user === undefined
        ? json(res, 404, { message: "Not Found" })
        : json(res, 200, { ...user, node_id: "U_fake", site_admin: false });
    }

    const repo = path.match(/^\/api\/repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/);
    if (repo !== null) {
      const fullName = `${repo[1]}/${repo[2]}`;
      const rest = repo[3] ?? "";
      const operation = operationFor(req.method ?? "GET", rest);
      if (operation !== null && failed(res, operation, fullName)) return true;
      const found = app.repositoryFor(token, fullName);
      if (found === "unauthorized") return json(res, 401, { message: "Bad credentials" });
      if (found === null) return json(res, 404, { message: "Not Found" });
      const state = accessOf(found.id);

      if (rest === "" && req.method === "GET") {
        return json(res, 200, { id: found.id, full_name: fullName, private: true });
      }
      if (rest === "/collaborators" && req.method === "GET") {
        const direct = [...state.collaborators.values()];
        const all =
          url.searchParams.get("affiliation") === "all" && !state.collaborators.has(found.owner.id)
            ? [{ ...found.owner, permission: "admin" as const }, ...direct]
            : direct;
        return json(res, 200, all.map(collaboratorJson));
      }
      if (rest === "/invitations" && req.method === "GET") {
        return json(
          res,
          200,
          state.invitations.map((invitation) => invitationJson(invitation, fullName)),
        );
      }
      const collaborator = rest.match(/^\/collaborators\/([\w-]+)$/);
      if (collaborator !== null && req.method === "PUT") {
        const user = app.userByLogin(collaborator[1] as string);
        if (user === undefined) return json(res, 404, { message: "Not Found" });
        if (state.collaborators.has(user.id)) return empty(res, 204);
        let invitation = pending(state, user.id);
        if (invitation === undefined) {
          invitation = {
            id: nextInvitationId++,
            invitee: { id: user.id, login: user.login },
            createdAt: new Date().toISOString(),
            expired: false,
          };
          state.invitations.push(invitation);
        }
        return json(res, 201, invitationJson(invitation, fullName));
      }
      if (collaborator !== null && req.method === "DELETE") {
        const user = app.userByLogin(collaborator[1] as string);
        return user !== undefined && state.collaborators.delete(user.id)
          ? empty(res, 204)
          : json(res, 404, { message: "Not Found" });
      }
      const invitation = rest.match(/^\/invitations\/(\d+)$/);
      if (invitation !== null && req.method === "DELETE") {
        const before = state.invitations.length;
        state.invitations = state.invitations.filter((i) => i.id !== Number(invitation[1]));
        return state.invitations.length < before
          ? empty(res, 204)
          : json(res, 404, { message: "Not Found" });
      }
      return json(res, 404, { message: "Not Found" });
    }

    if (path === "/_control/failures" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const operation = form.get("operation") ?? "";
      const status = Number(form.get("status"));
      if (!OPERATIONS.has(operation) || !(status >= 400 && status <= 599)) {
        return json(res, 400, { message: "operation and an error status are required" });
      }
      const repository = form.get("repository");
      failures.set(repository === null ? operation : `${operation} ${repository}`, {
        status,
        retryAfter: form.get("retry_after"),
      });
      return json(res, 200, { ok: true });
    }

    const control = path.match(/^\/_control\/repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/);
    if (control === null) return false;
    const fullName = `${control[1]}/${control[2]}`;
    const found = app.repositoryNamed(fullName);
    if (found === null) return json(res, 404, { message: "no repository" });
    const state = accessOf(found.id);
    const rest = control[3] ?? "";
    const form = new URLSearchParams(body);

    if (rest === "" && req.method === "GET") {
      return json(res, 200, {
        collaborators: [...state.collaborators.values()].map((c) => ({
          id: String(c.id),
          login: c.login,
          permission: c.permission,
        })),
        invitations: state.invitations.map((i) => ({
          id: String(i.id),
          inviteeId: String(i.invitee.id),
          inviteeLogin: i.invitee.login,
          createdAt: i.createdAt,
          expired: i.expired,
        })),
      });
    }
    if (rest === "/collaborators" && req.method === "POST") {
      const account: Account = {
        id: Number(form.get("id")),
        login: form.get("login") ?? "",
        type: "User",
      };
      const permission = (form.get("permission") ?? "write") as Permission;
      if (!(account.id > 0) || account.login === "" || !(permission in PERMISSIONS)) {
        return json(res, 400, { message: "id, login and a valid permission are required" });
      }
      if (app.userByLogin(account.login) === undefined) app.registerUser(account);
      state.collaborators.set(account.id, { id: account.id, login: account.login, permission });
      return json(res, 200, { ok: true });
    }
    const remove = rest.match(/^\/collaborators\/(\d+)\/remove$/);
    if (remove !== null && req.method === "POST") {
      return state.collaborators.delete(Number(remove[1]))
        ? json(res, 200, { ok: true })
        : json(res, 404, { message: "not a collaborator" });
    }
    const accept = rest.match(/^\/invitations\/by-user\/(\d+)\/accept$/);
    if (accept !== null && req.method === "POST") {
      const invitation = pending(state, Number(accept[1]));
      if (invitation === undefined) return json(res, 404, { message: "no pending invitation" });
      state.invitations = state.invitations.filter((i) => i !== invitation);
      state.collaborators.set(invitation.invitee.id, {
        ...invitation.invitee,
        permission: "write",
      });
      return json(res, 200, { ok: true });
    }
    const expire = rest.match(/^\/invitations\/(\d+)\/expire$/);
    if (expire !== null && req.method === "POST") {
      const invitation = state.invitations.find((i) => i.id === Number(expire[1]));
      if (invitation === undefined) return json(res, 404, { message: "no invitation" });
      invitation.expired = true;
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { message: "unknown control" });
  }

  return { handle };
}

/** The port operation an installation-token repository request belongs to, if any. */
function operationFor(method: string, rest: string): string | null {
  if (rest === "/collaborators" && method === "GET") return "listCollaborators";
  if (rest === "/invitations" && method === "GET") return "listInvitations";
  if (/^\/collaborators\/[^/]+$/.test(rest)) {
    if (method === "PUT") return "addCollaborator";
    if (method === "DELETE") return "removeCollaborator";
  }
  if (/^\/invitations\/[^/]+$/.test(rest) && method === "DELETE") return "cancelInvitation";
  return null;
}

function empty(res: ServerResponse, status: number): true {
  res.writeHead(status);
  res.end();
  return true;
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): true {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
  return true;
}
