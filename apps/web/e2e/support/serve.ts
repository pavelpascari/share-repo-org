// Starts both Workers for Playwright against a fresh local D1: wipes the state directory,
// applies every migration, starts jobs, waits for it, then starts web in the foreground.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
function start(cwd: string, args: string[]): ChildProcess {
  const child = spawn("pnpm", ["exec", ...args], { cwd, env, stdio: "inherit" });
  child.on("exit", (code) => shutdown(code ?? 1));
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start(jobsDir, ["wrangler", "dev", "--port", String(JOBS_PORT), "--persist-to", stateDir]);
await waitFor(`${JOBS_URL}/healthz`);
start(webDir, ["react-router", "dev", "--port", String(WEB_PORT), "--strictPort"]);

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
