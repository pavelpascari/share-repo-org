import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import { cloudflareContext } from "../app/context.ts";

const requestHandler = createRequestHandler(
  // The generated module types declare optional ServerBuild fields as `T | undefined`,
  // which `exactOptionalPropertyTypes` rejects; the runtime shape is a ServerBuild.
  () => import("virtual:react-router/server-build") as Promise<ServerBuild>,
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
