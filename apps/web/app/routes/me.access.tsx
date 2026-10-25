import { myAccess } from "@sharerepo/application";
import type { MyAccessEntitlement, MyAccessSubscription } from "@sharerepo/db";
import { servicesFor } from "../auth/server.ts";
import { requireUser } from "../auth/session.server.ts";
import { ENTITLEMENT_STATE_LABELS, GRANT_STATE_LABELS } from "../commerce-messages.ts";
import { cloudflareContext } from "../context.ts";
import { formatDate, SUBSCRIPTION_STATE_LABELS } from "../entitlement-messages.ts";
import type { Route } from "./+types/me.access";

export function meta(_: Route.MetaArgs) {
  return [{ title: "My access · ShareRepo" }];
}

const GITHUB_WEB = "https://github.com";

/** The signed-in user's own subscriptions across workspaces, and the access each gives. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await requireUser(request, context);
  return {
    subscriptions: await myAccess(servicesFor(context), user),
    githubWeb: context.get(cloudflareContext).env.github?.webBaseUrl ?? GITHUB_WEB,
    now: servicesFor(context).clock.now(),
  };
}

export default function MyAccess({ loaderData }: Route.ComponentProps) {
  const { subscriptions, githubWeb, now } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">My access</h1>
      <p className="mt-2 text-gray-700">
        Your subscriptions and the repositories they give your GitHub account access to.
      </p>
      {subscriptions.length === 0 ? (
        <p className="mt-6 text-gray-600">
          No subscriptions yet. If you paid with a link from a creator, claim the purchase on their
          claim page.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {subscriptions.map((subscription) => (
            <SubscriptionCard
              key={subscription.subscriptionId}
              subscription={subscription}
              githubWeb={githubWeb}
              now={now}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function subscriptionNote(subscription: MyAccessSubscription): string | null {
  if (subscription.endedAt !== null) return `Ended ${formatDate(subscription.endedAt)}`;
  if (subscription.cancelAt !== null) return `Cancels ${formatDate(subscription.cancelAt)}`;
  if (subscription.currentPeriodEnd !== null) {
    return `Renews ${formatDate(subscription.currentPeriodEnd)}`;
  }
  return null;
}

function SubscriptionCard(props: {
  subscription: MyAccessSubscription;
  githubWeb: string;
  now: number;
}) {
  const { subscription } = props;
  const note = subscriptionNote(subscription);
  return (
    <li className="rounded border border-gray-200 p-4" aria-label={subscription.workspace.name}>
      <h2 className="text-lg font-semibold">{subscription.workspace.name}</h2>
      <p className="text-sm text-gray-600">
        Subscription {SUBSCRIPTION_STATE_LABELS[subscription.state].toLowerCase()}
        {note === null ? "" : ` · ${note}`}
      </p>
      {subscription.entitlements.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No repositories yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {subscription.entitlements.map((entitlement) => (
            <Repository
              key={entitlement.id}
              entitlement={entitlement}
              githubWeb={props.githubWeb}
              now={props.now}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Repository(props: { entitlement: MyAccessEntitlement; githubWeb: string; now: number }) {
  const { entitlement } = props;
  // The latest grant is the one for the entitlement's access level, if ShareRepo made one.
  const grant =
    entitlement.grants.find((g) => g.accessLevel === entitlement.accessLevel) ??
    entitlement.grants[0] ??
    null;
  const invitationPending =
    entitlement.state === "active" &&
    grant?.state === "pending_invitation" &&
    (grant.expiresAt === null || grant.expiresAt > props.now);
  return (
    <li className="flex flex-col gap-1">
      <span className="font-mono">{entitlement.repositoryName}</span>
      <span className="text-sm text-gray-700">
        {ENTITLEMENT_STATE_LABELS[entitlement.state]}
        {entitlement.state === "active" &&
          grant !== null &&
          ` · ${GRANT_STATE_LABELS[grant.state]}`}
      </span>
      {invitationPending && (
        <a
          href={`${props.githubWeb}/${entitlement.repositoryName}/invitations`}
          className="text-sm underline"
        >
          Accept the invitation on GitHub
        </a>
      )}
    </li>
  );
}
