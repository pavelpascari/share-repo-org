import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// E2E runs point local bindings at a throwaway state directory (see e2e/support/serve.ts).
const persistDir = process.env.SHAREREPO_PERSIST_DIR;

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...(persistDir ? { persistState: { path: persistDir } } : {}),
    }),
    tailwindcss(),
    reactRouter(),
  ],
});
