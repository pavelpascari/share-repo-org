// A local stand-in for GitHub's OAuth web flow and `GET /user`, for E2E only (decision 0006).
// It behaves like GitHub where ShareRepo depends on it: the client secret, redirect URI and PKCE
// S256 verifier are checked, codes are single use, and failures use GitHub's response shapes.
// The authorize page lets a test choose which GitHub account (ID and login) signs in.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { FAKE_GITHUB_PORT } from "./ports.ts";

export const FAKE_CLIENT_ID = "e2e-client";
export const FAKE_CLIENT_SECRET = "e2e-client-secret";

interface Profile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface Grant {
  profile: Profile;
  redirectUri: string;
  codeChallenge: string | null;
}

export function startFakeGitHub(port = FAKE_GITHUB_PORT) {
  const codes = new Map<string, Grant>();
  const tokens = new Map<string, Profile>();
  // Every request ShareRepo or the browser makes, for assertions such as "no App installation".
  const calls: string[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === "/_control/calls") return json(res, 200, calls);
    calls.push(`${req.method} ${url.pathname}`);
    const body = await readBody(req);

    if (url.pathname === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== FAKE_CLIENT_ID) return send(res, 400, "bad client");
      if (req.method === "GET") return authorizePage(res, url);
      const form = new URLSearchParams(body);
      const target = new URL(url.searchParams.get("redirect_uri") ?? "");
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (form.get("decision") === "cancel") {
        target.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(12).toString("hex");
        codes.set(code, {
          profile: {
            id: Number(form.get("id")),
            login: form.get("login") ?? "",
            name: form.get("name") || null,
            avatar_url: "https://avatars.githubusercontent.com/u/1",
          },
          redirectUri: url.searchParams.get("redirect_uri") ?? "",
          codeChallenge: url.searchParams.get("code_challenge"),
        });
        target.searchParams.set("code", code);
      }
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(body);
      const code = form.get("code") ?? "";
      const grant = codes.get(code);
      codes.delete(code);
      const verifier = form.get("code_verifier");
      const pkceOk =
        grant?.codeChallenge != null &&
        verifier !== null &&
        createHash("sha256").update(verifier).digest("base64url") === grant.codeChallenge;
      if (
        grant === undefined ||
        form.get("client_id") !== FAKE_CLIENT_ID ||
        form.get("client_secret") !== FAKE_CLIENT_SECRET ||
        form.get("redirect_uri") !== grant.redirectUri ||
        !pkceOk
      ) {
        return json(res, 200, { error: "bad_verification_code" });
      }
      const token = `gho_fake_${randomBytes(12).toString("hex")}`;
      tokens.set(token, grant.profile);
      return json(res, 200, { access_token: token, token_type: "bearer", scope: "" });
    }

    if (req.method === "GET" && url.pathname === "/api/user") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const profile = tokens.get(token);
      return profile ? json(res, 200, profile) : json(res, 401, { message: "Bad credentials" });
    }

    send(res, 404, "not found");
  });
  server.listen(port);
  return server;
}

function authorizePage(res: ServerResponse, url: URL) {
  const action = `/login/oauth/authorize${url.search.replaceAll('"', "&quot;")}`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Fake GitHub</title><h1>Authorize ShareRepo</h1>
    <form method="post" action="${action}">
      <label>GitHub ID <input name="id" required></label>
      <label>Login <input name="login" required></label>
      <label>Name <input name="name"></label>
      <button type="submit" name="decision" value="authorize">Authorize</button>
      <button type="submit" name="decision" value="cancel" formnovalidate>Cancel</button>
    </form>`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function send(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
