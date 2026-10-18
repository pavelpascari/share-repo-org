// Dedicated ports so E2E runs do not collide with `pnpm dev` (5173 and 8788).
// The fake GitHub port is also in the `e2e` env of apps/web/wrangler.jsonc.
export const WEB_PORT = 5180;
export const JOBS_PORT = 8790;
export const FAKE_GITHUB_PORT = 5190;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const JOBS_URL = `http://localhost:${JOBS_PORT}`;
export const FAKE_GITHUB_URL = `http://localhost:${FAKE_GITHUB_PORT}`;
