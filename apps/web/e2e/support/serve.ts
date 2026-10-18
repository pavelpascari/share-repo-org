// Starts both Workers for Playwright against a fresh local D1: wipes the state directory,
// applies every migration, starts jobs and the fake GitHub, then starts web (wrangler env `e2e`,
// the only one that accepts GitHub endpoint overrides) in the foreground.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { FAKE_CLIENT_SECRET, startFakeGitHub } from "./fake-github.ts";
import { JOBS_PORT, JOBS_URL, WEB_PORT } from "./ports.ts";

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

start(jobsDir, ["wrangler", "dev", "--port", String(JOBS_PORT), "--persist-to", stateDir]);
await waitFor(`${JOBS_URL}/healthz`);
fakeGitHub = startFakeGitHub();
// Test-only secrets for the `e2e` env; .dev.vars* is gitignored.
writeFileSync(
  `${webDir}/.dev.vars.e2e`,
  `BETTER_AUTH_SECRET=e2e-better-auth-secret-0123456789abcdef\nGITHUB_CLIENT_SECRET=${FAKE_CLIENT_SECRET}\n`,
);
start(webDir, ["react-router", "dev", "--port", String(WEB_PORT), "--strictPort"], {
  CLOUDFLARE_ENV: "e2e",
});

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
