import type { SimulationOption } from "@sharerepo/application";
import { ConflictError } from "@sharerepo/platform";
import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "./context.ts";
import { CONFLICT_MESSAGE } from "./entitlement-messages.ts";
import { asResponse } from "./workspaces.server.ts";

type Context = Readonly<RouterContextProvider>;

/** The simulated billing source exists everywhere except production (decision 0009). */
export function simulatorEnabled(context: Context): boolean {
  return context.get(cloudflareContext).env.ENVIRONMENT !== "production";
}

export function simulationOption(context: Context): SimulationOption {
  return { enabled: simulatorEnabled(context) };
}

/**
 * Runs a state-changing service call for a form action. A concurrent change becomes a message
 * for the form; not found and forbidden become 404 and 403; anything else stays a 500.
 */
export async function attempt<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ConflictError) return { ok: false, error: CONFLICT_MESSAGE };
    throw asResponse(error);
  }
}
