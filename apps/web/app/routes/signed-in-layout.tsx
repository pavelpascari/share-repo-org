import { Form, Link, Outlet } from "react-router";
import { requireUser } from "../auth/session.server.ts";
import type { Route } from "./+types/signed-in-layout";

export async function loader({ request, context }: Route.LoaderArgs) {
  return { user: await requireUser(request, context) };
}

export default function SignedInLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
        <Link to="/" className="font-semibold">
          ShareRepo
        </Link>
        <Form method="post" action="/sign-out" className="flex items-center gap-3">
          <span className="text-sm text-gray-600">{loaderData.user.name}</span>
          <button type="submit" className="text-sm underline">
            Sign out
          </button>
        </Form>
      </header>
      <main className="mx-auto max-w-2xl p-8">
        <Outlet />
      </main>
    </div>
  );
}
