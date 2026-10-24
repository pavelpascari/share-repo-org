// The GitHub App half of the E2E fake GitHub: the install page, the App and installation REST
// endpoints ShareRepo calls, and control endpoints a test uses to register a user, or to change
// an installation and send a signed webhook. Response shapes follow GitHub's (see packages/integrations fixtures).
// Collaborators, invitations and their controls live in fake-github-collaborators.ts.
import { createHmac, randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFakeCollaborators } from "./fake-github-collaborators.ts";
import { WEB_URL } from "./ports.ts";

export const FAKE_APP_SLUG = "sharerepo-e2e";

interface Repository {
  id: number;
  name: string;
  private: boolean;
  archived: boolean;
}

interface Installation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" };
  repositories: Repository[];
  suspendedAt: string | null;
}

export function createFakeGitHubApp(webhookSecret: string) {
  const installations = new Map<number, Installation>();
  const tokens = new Map<string, number>();
  /** Accounts registered through `/_control/users`, keyed by lower-cased login. */
  const users = new Map<string, Installation["account"]>();

  const installationOf = (token: string) => {
    const id = tokens.get(token);
    return id === undefined ? undefined : installations.get(id);
  };
  const accounts = () => [
    ...users.values(),
    ...[...installations.values()].map((installation) => installation.account),
  ];
  const repositoryIn = (installation: Installation, fullName: string) => {
    const repository = installation.repositories.find((r) => r.name === fullName);
    return repository === undefined ? null : { id: repository.id, owner: installation.account };
  };
  const collaborators = createFakeCollaborators({
    repositoryFor(token, fullName) {
      const installation = installationOf(token);
      return installation === undefined ? "unauthorized" : repositoryIn(installation, fullName);
    },
    repositoryNamed(fullName) {
      for (const installation of installations.values()) {
        const found = repositoryIn(installation, fullName);
        if (found !== null) return found;
      }
      return null;
    },
    userByLogin: (login) => accounts().find((a) => a.login.toLowerCase() === login.toLowerCase()),
    userById: (id) => accounts().find((a) => a.id === id),
    registerUser: (account) => users.set(account.login.toLowerCase(), account),
    isInstallationToken: (token) => installationOf(token) !== undefined,
  });

  function installationJson(installation: Installation) {
    return {
      id: installation.id,
      account: { ...installation.account, node_id: "U_fake", site_admin: false },
      repository_selection: "selected",
      app_id: 1000,
      app_slug: FAKE_APP_SLUG,
      target_id: installation.account.id,
      target_type: installation.account.type,
      permissions: { administration: "write", metadata: "read" },
      events: ["repository"],
      suspended_at: installation.suspendedAt,
    };
  }

  /** Returns true when it answered the request. */
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: string,
  ): Promise<boolean> {
    const path = url.pathname;
    const install = path.match(/^\/apps\/([\w-]+)\/installations\/new$/);
    if (install !== null) {
      if (req.method === "GET") return page(res, installPage(url));
      const form = new URLSearchParams(body);
      const id = randomInt(1, 2 ** 31);
      const login = form.get("login") ?? "";
      installations.set(id, {
        id,
        account: {
          id: Number(form.get("account_id")),
          login,
          type: form.get("type") === "Organization" ? "Organization" : "User",
        },
        repositories: (form.get("repositories") ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "")
          .map((name) => ({
            id: randomInt(1, 2 ** 31),
            name: `${login}/${name}`,
            private: true,
            archived: false,
          })),
        suspendedAt: null,
      });
      const setup = new URL(`${WEB_URL}/github/setup`);
      setup.searchParams.set("installation_id", String(id));
      setup.searchParams.set("setup_action", "install");
      setup.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: setup.toString() });
      res.end();
      return true;
    }

    const token = path.match(/^\/api\/app\/installations\/(\d+)\/access_tokens$/);
    if (token !== null && req.method === "POST") {
      if (!isBearer(req))
        return json(res, 401, { message: "A JSON web token could not be decoded" });
      const installation = installations.get(Number(token[1]));
      if (installation === undefined) return json(res, 404, { message: "Not Found" });
      if (installation.suspendedAt !== null) {
        return json(res, 403, { message: "This installation has been suspended" });
      }
      const value = `ghs_fake_${randomInt(1, 2 ** 40)}`;
      tokens.set(value, installation.id);
      return json(res, 201, {
        token: value,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { administration: "write", metadata: "read" },
        repository_selection: "selected",
      });
    }

    const get = path.match(/^\/api\/app\/installations\/(\d+)$/);
    if (get !== null && req.method === "GET") {
      if (!isBearer(req))
        return json(res, 401, { message: "A JSON web token could not be decoded" });
      const installation = installations.get(Number(get[1]));
      return installation === undefined
        ? json(res, 404, { message: "Not Found" })
        : json(res, 200, installationJson(installation));
    }

    if (path === "/api/installation/repositories" && req.method === "GET") {
      const id = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      const installation = id === undefined ? undefined : installations.get(id);
      if (installation === undefined) return json(res, 401, { message: "Bad credentials" });
      return json(res, 200, {
        total_count: installation.repositories.length,
        repository_selection: "selected",
        repositories: installation.repositories.map((repository) => ({
          id: repository.id,
          full_name: repository.name,
          name: repository.name.split("/")[1],
          owner: { ...installation.account, site_admin: false },
          private: repository.private,
          archived: repository.archived,
        })),
      });
    }

    const userPath = path.match(/^\/api\/users\/([\w-]+)$/);
    if (userPath !== null && req.method === "GET") {
      if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        return json(res, 401, { message: "Bad credentials" });
      }
      const login = (userPath[1] as string).toLowerCase();
      const user =
        users.get(login) ??
        [...installations.values()].find((i) => i.account.login.toLowerCase() === login)?.account;
      return user === undefined
        ? json(res, 404, { message: "Not Found" })
        : json(res, 200, { ...user, node_id: "U_fake", site_admin: false });
    }

    // Controls: make a GitHub account exist, so ShareRepo can resolve its login.
    if (path === "/_control/users" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const login = form.get("login") ?? "";
      users.set(login.toLowerCase(), { id: Number(form.get("id")), login, type: "User" });
      return json(res, 200, { ok: true });
    }

    // Controls: change an installation as its owner would on GitHub, then tell ShareRepo.
    const remove = path.match(/^\/_control\/installations\/by-login\/([\w-]+)\/remove-repository$/);
    if (remove !== null && req.method === "POST") {
      const installation = [...installations.values()].find((i) => i.account.login === remove[1]);
      if (installation === undefined) return json(res, 404, { message: "no installation" });
      const name = new URLSearchParams(body).get("name");
      installation.repositories = installation.repositories.filter(
        (r) => !r.name.endsWith(`/${name}`),
      );
      await deliverWebhook("installation_repositories", "removed", installation.id);
      return json(res, 200, { ok: true });
    }
    return collaborators.handle(req, res, url, body);
  }

  async function deliverWebhook(event: string, action: string, installationId: number) {
    const payload = JSON.stringify({ action, installation: { id: installationId } });
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`;
    await fetch(`${WEB_URL}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
  }

  return { handle };
}

function isBearer(req: IncomingMessage): boolean {
  return /^Bearer \S+$/.test(req.headers.authorization ?? "");
}

function installPage(url: URL): string {
  const action = `${url.pathname}${url.search.replaceAll('"', "&quot;")}`;
  return `<!doctype html><title>Fake GitHub</title><h1>Install ShareRepo</h1>
    <form method="post" action="${action}">
      <label>Account ID <input name="account_id" required></label>
      <label>Account login <input name="login" required></label>
      <label>Account type
        <select name="type"><option>User</option><option>Organization</option></select>
      </label>
      <label>Repositories <input name="repositories" placeholder="course-code, extras"></label>
      <button type="submit">Install</button>
    </form>`;
}

function page(res: ServerResponse, html: string): true {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

function json(res: ServerResponse, status: number, value: unknown): true {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
  return true;
}
