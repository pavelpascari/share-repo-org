// Dedicated ports so E2E runs do not collide with `pnpm dev` (5173 and 8788). The jobs Worker
// runs inside the web dev server during E2E (vite.config.ts), so it has no port of its own.
// The fake GitHub and fake Paddle ports are also in the `e2e` envs of apps/web/wrangler.jsonc and
// apps/jobs/wrangler.jsonc.
export const WEB_PORT = 5180;
export const FAKE_GITHUB_PORT = 5190;
export const FAKE_PADDLE_PORT = 5191;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const FAKE_GITHUB_URL = `http://localhost:${FAKE_GITHUB_PORT}`;
export const FAKE_PADDLE_URL = `http://localhost:${FAKE_PADDLE_PORT}`;
/** serve.ts prints this once both fakes run and the dev server is warm (playwright.config.ts). */
export const READY_LINE = "E2E servers ready";
