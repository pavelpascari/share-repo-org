import { authorizeOperator, type OperatorPrincipal } from "@sharerepo/application";
import { data, type RouterContextProvider } from "react-router";
import { servicesFor } from "./auth/server.ts";
import { getSignedInUser } from "./auth/session.server.ts";
import { cloudflareContext } from "./context.ts";

type Context = Readonly<RouterContextProvider>;

/**
 * The signed-in operator (decision 0014): the session's user, whose linked GitHub account ID is
 * listed in `OPERATOR_GITHUB_IDS`. Anyone else, signed in or not, gets a 404 before anything is
 * read, so the operator pages' existence is not revealed (threats O1 and O2).
 */
export async function requireOperator(
  request: Request,
  context: Context,
): Promise<OperatorPrincipal> {
  const { operatorGitHubIds } = context.get(cloudflareContext).env;
  const user = operatorGitHubIds.size === 0 ? null : await getSignedInUser(request, context);
  const operator =
    user === null ? null : await authorizeOperator(servicesFor(context), user, operatorGitHubIds);
  if (operator === null) throw data(null, { status: 404 });
  return operator;
}
