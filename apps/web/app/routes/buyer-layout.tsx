import { Form, Link, Outlet } from "react-router";
import { getSignedInUser } from "../auth/session.server.ts";
import type { Route } from "./+types/buyer-layout";

// Pages a buyer reaches from a creator's link (checkout, claims). Unlike the signed-in layout,
// a signed-out visitor stays on the page, which offers GitHub sign-in and comes back.

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await getSignedInUser(request, context);
  return { user: user === null ? null : { name: user.name } };
}

export default function BuyerLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
        <Link to="/" className="font-semibold">
          ShareRepo
        </Link>
        {user !== null && (
          <Form method="post" action="/sign-out" className="flex items-center gap-3">
            <Link to="/me/access" className="text-sm underline">
              My access
            </Link>
            <span className="text-sm text-gray-600">{user.name}</span>
            <button type="submit" className="text-sm underline">
              Sign out
            </button>
          </Form>
        )}
      </header>
      <main className="mx-auto max-w-2xl p-4 sm:p-8">
        <Outlet />
      </main>
    </div>
  );
}
