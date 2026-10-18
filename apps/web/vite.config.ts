import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// E2E runs point local bindings at a throwaway state directory (see e2e/support/serve.ts).
const persistDir = process.env.SHAREREPO_PERSIST_DIR;
// E2E also runs the jobs Worker in the same local runtime, so both share one D1 and the EVENTS
// queue. Two separate local processes on one SQLite file fail under concurrent writes.
const withJobs = process.env.SHAREREPO_WITH_JOBS === "1";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...(persistDir ? { persistState: { path: persistDir } } : {}),
      ...(withJobs ? { auxiliaryWorkers: [{ configPath: "../jobs/wrangler.jsonc" }] } : {}),
    }),
    tailwindcss(),
    reactRouter(),
  ],
});
