import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/sign-in.ts"),
  route("sign-out", "routes/sign-out.ts"),
  // Only the OAuth callback is exposed. Sign-in and sign-out go through our own actions, so
  // Better Auth's other endpoints (account linking, profile updates) are unreachable.
  route("api/auth/callback/github", "routes/api.auth.callback.ts"),
  layout("routes/signed-in-layout.tsx", [
    route("workspaces/new", "routes/workspaces.new.tsx"),
    route("w/:slug", "routes/w.$slug.tsx", [
      index("routes/w.$slug._index.tsx"),
      route("settings", "routes/w.$slug.settings.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
