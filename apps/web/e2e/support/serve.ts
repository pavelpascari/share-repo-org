// Starts both Workers for Playwright against a fresh local D1: wipes the state directory, applies
// every migration, starts the fake GitHub and the fake Paddle, then starts web with jobs as an
// auxiliary Worker in one local runtime (wrangler env `e2e`, the only one that accepts provider
// endpoint overrides). Once the dev server answers, it is warmed up (see `warmUp`) before the
// ready line tells Playwright to start the tests.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { FAKE_CLIENT_SECRET, startFakeGitHub } from "./fake-github.ts";
import { startFakePaddle } from "./fake-paddle.ts";
import { OPERATOR_GITHUB_ID, READY_LINE, WEB_PORT, WEB_URL } from "./ports.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const stateDir = `${root}.e2e/state`;
const webDir = `${root}apps/web`;
const jobsDir = `${root}apps/jobs`;
const env = { ...process.env, SHAREREPO_PERSIST_DIR: stateDir };

rmSync(stateDir, { recursive: true, force: true });
execFileSync(
  "pnpm",
  ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir],
  { cwd: webDir, env, stdio: "inherit" },
);

const children: ChildProcess[] = [];
const fakes: Server[] = [];
function start(cwd: string, args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn("pnpm", ["exec", ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
  });
  child.on("exit", (code) => shutdown(code ?? 1));
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  for (const fake of fakes) fake.close();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Test-only secrets for the `e2e` envs, fresh per run; .dev.vars* is gitignored.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const appKey = JSON.stringify(privateKey); // one line, with \n escapes
const webhookSecret = randomBytes(32).toString("hex");
// Commerce secrets (decisions 0011 and 0012), shared by both Workers: they read one database.
const commerceSecrets = [
  `CREDENTIAL_KEYS=${JSON.stringify({ current: "e2e", keys: { e2e: randomBytes(32).toString("base64") } })}`,
  `CLAIM_SIGNING_KEY=${randomBytes(32).toString("hex")}`,
];
writeFileSync(
  `${webDir}/.dev.vars.e2e`,
  [
    "BETTER_AUTH_SECRET=e2e-better-auth-secret-0123456789abcdef",
    `GITHUB_CLIENT_SECRET=${FAKE_CLIENT_SECRET}`,
    `GITHUB_APP_PRIVATE_KEY=${appKey}`,
    `GITHUB_WEBHOOK_SECRET=${webhookSecret}`,
    ...commerceSecrets,
    // Overrides the e2e env's empty var: one operator for the /ops journeys.
    `OPERATOR_GITHUB_IDS=${OPERATOR_GITHUB_ID}`,
    "",
  ].join("\n"),
);
writeFileSync(
  `${jobsDir}/.dev.vars.e2e`,
  [`GITHUB_APP_PRIVATE_KEY=${appKey}`, ...commerceSecrets, ""].join("\n"),
);

fakes.push(startFakeGitHub({ webhookSecret }), startFakePaddle());
start(webDir, ["react-router", "dev", "--port", String(WEB_PORT), "--strictPort"], {
  CLOUDFLARE_ENV: "e2e",
  SHAREREPO_WITH_JOBS: "1",
});
await warmUp().catch((error: unknown) => {
  console.error("E2E warm-up failed", error);
  shutdown(1);
});
console.log(READY_LINE);

/**
 * A cold dev server compiles the server bundle on its first page request (seconds) and each
 * browser module on first use; with every worker's first `page.goto` arriving at once, early tests
 * used to time out. So before the tests start: wait for /readyz, render a page (the server
 * bundle), then fetch every browser module reachable from the root and the route files, which
 * also runs Vite's dependency optimizer before any browser could be reloaded by it.
 */
async function warmUp(): Promise<void> {
  const deadline = Date.now() + 110_000;
  while (
    !(await fetch(`${WEB_URL}/readyz`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error("the dev server did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const home = await (await fetch(`${WEB_URL}/`)).text();
  const routes = readdirSync(`${webDir}/app/routes`).map((file) => `/app/routes/${file}`);
  const preloads = [...home.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((match) => match[1] ?? "");
  await crawl(["/@vite/client", "/app/root.tsx", ...preloads, ...routes]);
}

/** Fetches modules and, transitively, the absolute imports in their transformed source. */
async function crawl(start: string[]): Promise<void> {
  const seen = new Set<string>();
  let frontier = start;
  while (frontier.length > 0 && seen.size < 2000) {
    const batch = [...new Set(frontier)].filter((path) => !seen.has(path));
    for (const path of batch) seen.add(path);
    const sources = await Promise.all(
      batch.map((path) =>
        fetch(`${WEB_URL}${path}`).then(
          (response) => (response.ok ? response.text() : ""),
          () => "",
        ),
      ),
    );
    frontier = sources.flatMap((source) =>
      [...source.matchAll(/(?:from|import)\s*\(?\s*"(\/[^"]+)"/g)].map((match) => match[1] ?? ""),
    );
  }
}
