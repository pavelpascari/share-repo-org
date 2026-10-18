import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "ShareRepo" }];
}

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">ShareRepo</h1>
      <p className="mt-2 text-gray-600">Sell access to private repositories.</p>
    </main>
  );
}
