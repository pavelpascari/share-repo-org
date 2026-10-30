import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/sign-in.ts"),
  route("sign-out", "routes/sign-out.ts"),
  // Only the OAuth callback is exposed. Sign-in and sign-out go through our own actions, so
  // Better Auth's other endpoints (account linking, profile updates) are unreachable.
  route("api/auth/callback/github", "routes/api.auth.callback.ts"),
  // A buyer's pages: signed-out visitors are offered sign-in and come back (decision 0012).
  layout("routes/buyer-layout.tsx", [
    route("buy/:offerId", "routes/buy.$offerId.tsx"),
    route("c/:slug/claim", "routes/c.$slug.claim.tsx"),
    route("claim/:token", "routes/claim.$token.tsx"),
  ]),
  // Operators only (decision 0014). Outside the signed-in layout, which redirects signed-out
  // visitors: here everyone who is not an operator gets the same 404.
  route("ops", "routes/ops.tsx"),
  route("ops/w/:slug", "routes/ops.w.$slug.tsx"),
  layout("routes/signed-in-layout.tsx", [
    route("workspaces/new", "routes/workspaces.new.tsx"),
    route("github/setup", "routes/github.setup.ts"),
    route("me", "routes/me.tsx"),
    route("me/access", "routes/me.access.tsx"),
    route("w/:slug", "routes/w.$slug.tsx", [
      index("routes/w.$slug._index.tsx"),
      route("settings", "routes/w.$slug.settings.tsx"),
      route("export", "routes/w.$slug.export.ts"),
      route("repositories", "routes/w.$slug.repositories.tsx"),
      route("offers", "routes/w.$slug.offers.tsx"),
      route("access", "routes/w.$slug.access.tsx"),
      route("simulator", "routes/w.$slug.simulator.tsx"),
      route("billing", "routes/w.$slug.billing.tsx"),
      route("customers", "routes/w.$slug.customers.tsx"),
      route("manual-access", "routes/w.$slug.manual-access.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
