import { createRequestHandler, type ServerBuild } from "react-router";
import { createFetchHandler } from "./handler.ts";

// Framework wiring only; behaviour lives in handler.ts. The server build is imported lazily, so
// probes are answered (and this module loads under Vitest) without resolving the virtual module.
const renderApp = createRequestHandler(
  // The generated module types declare optional ServerBuild fields as `T | undefined`,
  // which `exactOptionalPropertyTypes` rejects; the runtime shape is a ServerBuild.
  () => import("virtual:react-router/server-build") as Promise<ServerBuild>,
  import.meta.env.MODE,
);

export default {
  fetch: createFetchHandler({ renderApp }),
} satisfies ExportedHandler<Env>;
