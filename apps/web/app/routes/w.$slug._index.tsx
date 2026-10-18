import { useRouteLoaderData } from "react-router";
import type { loader } from "./w.$slug.tsx";

export default function WorkspaceOverview() {
  const layout = useRouteLoaderData<typeof loader>("routes/w.$slug");
  if (layout === undefined) return null;
  const { workspace } = layout;
  return (
    <>
      <h1 className="text-2xl font-semibold">{workspace.name}</h1>
      <p className="mt-2 text-gray-600">
        You are {workspace.role === "owner" ? "an owner" : "a member"} of this workspace.
      </p>
    </>
  );
}
