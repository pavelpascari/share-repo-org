import { defineConfig } from "drizzle-kit";

// Generate only. Migrations are applied by Wrangler (`wrangler d1 migrations apply`), never by
// drizzle-kit. See packages/db/README.md for the verified folder layout.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
