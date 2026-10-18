// Dedicated ports so E2E runs do not collide with `pnpm dev` (5173 and 8788).
export const WEB_PORT = 5180;
export const JOBS_PORT = 8790;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const JOBS_URL = `http://localhost:${JOBS_PORT}`;
