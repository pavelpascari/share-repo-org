// Starts both Workers for Playwright against a fresh local D1: wipes the state directory, applies
// every migration, starts the fake GitHub, then starts web with jobs as an auxiliary Worker in one
// local runtime (wrangler env `e2e`, the only one that accepts GitHub endpoint overrides).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { FAKE_CLIENT_SECRET, startFakeGitHub } from "./fake-github.ts";
import { WEB_PORT } from "./ports.ts";

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
let fakeGitHub: Server | undefined;
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
  fakeGitHub?.close();
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
writeFileSync(
  `${webDir}/.dev.vars.e2e`,
  [
    "BETTER_AUTH_SECRET=e2e-better-auth-secret-0123456789abcdef",
    `GITHUB_CLIENT_SECRET=${FAKE_CLIENT_SECRET}`,
    `GITHUB_APP_PRIVATE_KEY=${appKey}`,
    `GITHUB_WEBHOOK_SECRET=${webhookSecret}`,
    "",
  ].join("\n"),
);
writeFileSync(`${jobsDir}/.dev.vars.e2e`, `GITHUB_APP_PRIVATE_KEY=${appKey}\n`);

fakeGitHub = startFakeGitHub({ webhookSecret });
start(webDir, ["react-router", "dev", "--port", String(WEB_PORT), "--strictPort"], {
  CLOUDFLARE_ENV: "e2e",
  SHAREREPO_WITH_JOBS: "1",
});
