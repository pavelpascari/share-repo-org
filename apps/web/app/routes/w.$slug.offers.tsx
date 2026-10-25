import {
  archiveOffer,
  type CatalogPrice,
  createOffer,
  encodeOfferKey,
  getBillingView,
  listOfferableResources,
  listOffers,
  type OfferableResource,
  type OfferResult,
  type OfferSummary,
  updateOffer,
} from "@sharerepo/application";
import { GRACE_PERIOD_DAYS_DEFAULT, OutboxKind, roleAllows } from "@sharerepo/domain";
import {
  TextField as AriaTextField,
  Button,
  Dialog,
  DialogTrigger,
  Heading,
  Label,
  Modal,
  ModalOverlay,
  Text,
  TextArea,
} from "react-aria-components";
import { data, Form, Link, useNavigation } from "react-router";
import { servicesFor } from "../auth/server.ts";
import { commerceFor, publicOrigin } from "../commerce.server.ts";
import { priceLabel } from "../commerce-messages.ts";
import { Checkbox } from "../components/checkbox.tsx";
import { TextField } from "../components/text-field.tsx";
import { cloudflareContext } from "../context.ts";
import {
  OFFER_STATUS_LABELS,
  offerErrorMessages,
  parseItemIds,
  repositoryUnavailableReason,
} from "../entitlement-messages.ts";
import { attempt, simulatorEnabled } from "../entitlements.server.ts";
import { enqueueJob } from "../jobs.server.ts";
import { assertSameOrigin } from "../security/same-origin.ts";
import { asResponse, loadWorkspace } from "../workspaces.server.ts";
import type { Route } from "./+types/w.$slug.offers";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Offers · ShareRepo" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { user, workspace } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const services = servicesFor(context);
  const [offers, repositories] = await Promise.all([
    listOffers(services, user, params.slug),
    listOfferableResources(services, user, params.slug),
  ]).catch((error: unknown) => {
    throw asResponse(error);
  });
  const canManage = roleAllows(workspace.role, "workspace.manage");
  // The owner chooses Paddle prices from the catalog while Paddle is connected.
  const billing =
    canManage && commerceFor(context) !== null
      ? await getBillingView(services, user, params.slug).catch((error: unknown) => {
          throw asResponse(error);
        })
      : null;
  return {
    offers,
    repositories,
    canManage,
    paddlePrices: billing?.connection ? billing.prices : null,
    simulatedItems: simulatorEnabled(context),
    origin: publicOrigin(context),
    slug: params.slug,
    // From the loader, so the domain package stays out of the browser bundle.
    defaultGracePeriodDays: GRACE_PERIOD_DAYS_DEFAULT,
    editing: new URL(request.url).searchParams.get("edit"),
  };
}

/**
 * The offer configuration a form submits; the service validates it. Paddle prices come from the
 * catalog checkboxes; simulated item IDs from free text, outside production only.
 */
function offerInput(form: FormData, simulated: boolean) {
  const grace = String(form.get("gracePeriodDays") ?? "").trim();
  const simulatedItems = simulated
    ? parseItemIds(String(form.get("items") ?? "")).map((externalItemId) => ({
        source: "simulated",
        externalItemId,
      }))
    : [];
  const paddleItems = form
    .getAll("paddlePrices")
    .map((priceId) => ({ source: "paddle", externalItemId: String(priceId) }));
  return {
    name: String(form.get("name") ?? ""),
    gracePeriodDays: grace === "" ? undefined : Number(grace),
    items: [...paddleItems, ...simulatedItems],
    // Personal repositories can only be granted write access (decision 0008).
    accesses: form
      .getAll("repositories")
      .map((resourceId) => ({ resourceId: String(resourceId), accessLevel: "write" })),
  };
}

type ActionData =
  | { ok: true; notice: string; errors: []; formKey: string }
  | { ok: false; notice: null; errors: string[]; formKey: string };

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request, context.get(cloudflareContext).env.auth.baseURL);
  const { user, workspace } = await loadWorkspace(request, context, params.slug, "workspace.read");
  const services = servicesFor(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const offerId = String(form.get("offerId") ?? "");
  const formKey = intent === "create" ? "new" : offerId;
  const simulated = simulatorEnabled(context);

  const run = async (): Promise<OfferResult> => {
    if (intent === "create")
      return createOffer(services, user, params.slug, offerInput(form, simulated));
    if (intent === "update") {
      return updateOffer(services, user, params.slug, offerId, offerInput(form, simulated));
    }
    if (intent === "archive") return archiveOffer(services, user, params.slug, offerId);
    throw data(null, { status: 400 });
  };
  const attempted = await attempt(run);
  if (!attempted.ok) {
    return { ok: false, notice: null, errors: [attempted.error], formKey } satisfies ActionData;
  }
  const result = attempted.value;
  if (!result.ok) {
    const repositories = await listOfferableResources(services, user, params.slug);
    const names = new Map(repositories.map((r) => [r.id, r.name]));
    return {
      ok: false,
      notice: null,
      errors: offerErrorMessages(result.errors, names),
      formKey,
    } satisfies ActionData;
  }
  if (result.outboxId !== null) {
    enqueueJob(context, {
      kind: OutboxKind.RecomputeOffer,
      subjectId: encodeOfferKey({ workspaceId: workspace.id, offerId: result.offer.id }),
      outboxId: result.outboxId,
    });
  }
  const notice =
    intent === "create"
      ? `Created “${result.offer.name}”.`
      : intent === "archive"
        ? `Archived “${result.offer.name}”.`
        : `Saved “${result.offer.name}” (version ${result.offer.version}).`;
  return { ok: true, notice, errors: [], formKey } satisfies ActionData;
}

export default function Offers({ loaderData, actionData }: Route.ComponentProps) {
  const { offers, repositories, canManage, editing, defaultGracePeriodDays } = loaderData;
  const { paddlePrices, simulatedItems, origin, slug } = loaderData;
  const names = new Map(repositories.map((r) => [r.id, r.name]));
  const prices = new Map((paddlePrices ?? []).map((price) => [price.priceId, price]));
  const editingOffer = offers.find((offer) => offer.id === editing && offer.status === "active");
  const sellsWithPaddle = offers.some(
    (offer) => offer.status === "active" && offer.items.some((item) => item.source === "paddle"),
  );
  const itemChoices = { paddlePrices, simulatedItems };
  return (
    <>
      <h1 className="text-2xl font-semibold">Offers</h1>
      <p className="mt-2 text-gray-700">
        An offer sells access to repositories. Subscriptions to any of its commercial items give
        their subscribers access.
      </p>
      {actionData?.ok && (
        <p role="status" className="mt-4 text-green-800">
          {actionData.notice}
        </p>
      )}
      {sellsWithPaddle && (
        <p className="mt-4 text-sm text-gray-700">
          Buyers who paid through a Paddle link you shared can claim their purchase at{" "}
          <CopyableUrl label="Claim page link" url={`${origin}/c/${slug}/claim`} />
        </p>
      )}
      {offers.length === 0 ? (
        <p className="mt-6 text-gray-600">No offers yet.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {offers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              repositoryNames={names}
              prices={prices}
              checkoutUrl={`${origin}/buy/${offer.id}`}
              canManage={canManage}
              errors={actionData?.formKey === offer.id && !actionData.ok ? actionData.errors : []}
            />
          ))}
        </ul>
      )}
      {canManage &&
        (editingOffer === undefined ? (
          <OfferForm
            defaultGracePeriodDays={defaultGracePeriodDays}
            key="new"
            heading="New offer"
            repositories={repositories}
            {...itemChoices}
            errors={actionData?.formKey === "new" && !actionData.ok ? actionData.errors : []}
          />
        ) : (
          <OfferForm
            defaultGracePeriodDays={defaultGracePeriodDays}
            key={`${editingOffer.id}-${editingOffer.version}`}
            heading={`Edit “${editingOffer.name}”`}
            offer={editingOffer}
            repositories={repositories}
            {...itemChoices}
            errors={
              actionData?.formKey === editingOffer.id && !actionData.ok ? actionData.errors : []
            }
          />
        ))}
    </>
  );
}

function Errors({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="flex flex-col gap-1 text-red-700">
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}

/** A URL to copy: a read-only field with its own accessible name. */
function CopyableUrl({ label, url }: { label: string; url: string }) {
  return (
    <input
      readOnly
      aria-label={label}
      value={url}
      onFocus={(event) => event.currentTarget.select()}
      className="w-full max-w-md rounded border border-gray-300 bg-gray-50 px-2 py-1 font-mono text-sm"
    />
  );
}

function itemText(
  item: { source: string; externalItemId: string },
  prices: ReadonlyMap<string, CatalogPrice>,
) {
  const price = item.source === "paddle" ? prices.get(item.externalItemId) : undefined;
  return price === undefined ? item.externalItemId : `${priceLabel(price)} (${price.priceId})`;
}

function OfferCard(props: {
  offer: OfferSummary;
  repositoryNames: ReadonlyMap<string, string>;
  prices: ReadonlyMap<string, CatalogPrice>;
  checkoutUrl: string;
  canManage: boolean;
  errors: readonly string[];
}) {
  const { offer, repositoryNames, canManage } = props;
  const archived = offer.status === "archived";
  const sellsWithPaddle = !archived && offer.items.some((item) => item.source === "paddle");
  return (
    <li className="rounded border border-gray-200 p-4" aria-label={offer.name}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{offer.name}</h2>
        <span className="text-sm text-gray-600">
          {OFFER_STATUS_LABELS[offer.status]} · version {offer.version}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-600">Grace period</dt>
        <dd>
          {offer.gracePeriodDays} {offer.gracePeriodDays === 1 ? "day" : "days"}
        </dd>
        <dt className="text-gray-600">Repositories</dt>
        <dd>
          {offer.accesses
            .map(
              (access) =>
                `${repositoryNames.get(access.resourceId) ?? "Unknown repository"} (${access.accessLevel === "write" ? "write" : "read"} access)`,
            )
            .join(", ")}
        </dd>
        <dt className="text-gray-600">Commercial items</dt>
        <dd>
          {offer.items.length === 0
            ? "None yet"
            : offer.items.map((item) => itemText(item, props.prices)).join(", ")}
        </dd>
        {sellsWithPaddle && (
          <>
            <dt className="text-gray-600">Checkout link</dt>
            <dd>
              <CopyableUrl label={`Checkout link for ${offer.name}`} url={props.checkoutUrl} />
            </dd>
          </>
        )}
      </dl>
      <Errors errors={props.errors} />
      {canManage && !archived && (
        <div className="mt-3 flex gap-4 text-sm">
          <Link to={`?edit=${offer.id}`} className="underline">
            Edit
          </Link>
          <ArchiveButton offer={offer} />
        </div>
      )}
    </li>
  );
}

function ArchiveButton({ offer }: { offer: OfferSummary }) {
  return (
    <DialogTrigger>
      <Button className="underline">Archive</Button>
      <ModalOverlay className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
        <Modal className="w-full max-w-md rounded bg-white p-6 shadow-lg">
          <Dialog role="alertdialog" className="outline-none">
            {({ close }) => (
              <Form method="post" className="flex flex-col gap-4" onSubmit={() => close()}>
                <Heading slot="title" className="text-lg font-semibold">
                  Archive “{offer.name}”?
                </Heading>
                <p className="text-gray-700">
                  Subscribers lose the access this offer gives them, and the offer can't be edited
                  again. Its history is kept.
                </p>
                <input type="hidden" name="intent" value="archive" />
                <input type="hidden" name="offerId" value={offer.id} />
                <div className="flex justify-end gap-3">
                  <Button onPress={close} className="rounded px-4 py-2 underline">
                    Keep offer
                  </Button>
                  <Button type="submit" className="rounded bg-red-700 px-4 py-2 text-white">
                    Archive offer
                  </Button>
                </div>
              </Form>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

function OfferForm(props: {
  defaultGracePeriodDays: number;
  heading: string;
  offer?: OfferSummary;
  repositories: readonly OfferableResource[];
  /** The Paddle catalog while Paddle is connected; null otherwise. */
  paddlePrices: readonly CatalogPrice[] | null;
  simulatedItems: boolean;
  errors: readonly string[];
}) {
  const { offer, repositories, paddlePrices } = props;
  const offerItems = offer?.items ?? [];
  const selectedPrices = new Set(
    offerItems.filter((item) => item.source === "paddle").map((item) => item.externalItemId),
  );
  // Active recurring prices can be added; prices already in the offer stay listed whatever their
  // state, so saving never drops them silently.
  const choosable = (paddlePrices ?? []).filter(
    (price) =>
      selectedPrices.has(price.priceId) ||
      (price.status === "active" && price.billingInterval !== null),
  );
  const known = new Set(choosable.map((price) => price.priceId));
  const unknownSelected = [...selectedPrices].filter((priceId) => !known.has(priceId));
  const navigation = useNavigation();
  const inOffer = new Set(offer?.accesses.map((access) => access.resourceId) ?? []);
  // Unsellable repositories can't be added, but ones already in the offer stay listed.
  const listed = repositories.filter((r) => r.sellable || inOffer.has(r.id));
  const unavailable = repositories.filter((r) => !r.sellable && !inOffer.has(r.id));
  return (
    <Form method="post" className="mt-10 flex flex-col gap-5 border-t border-gray-200 pt-6">
      <h2 className="text-lg font-semibold">{props.heading}</h2>
      <Errors errors={props.errors} />
      <input type="hidden" name="intent" value={offer === undefined ? "create" : "update"} />
      {offer !== undefined && <input type="hidden" name="offerId" value={offer.id} />}
      <TextField name="name" label="Name" isRequired defaultValue={offer?.name ?? ""} />
      <TextField
        name="gracePeriodDays"
        label="Grace period (days)"
        type="number"
        min={0}
        max={30}
        isRequired
        defaultValue={String(offer?.gracePeriodDays ?? props.defaultGracePeriodDays)}
        description="How long subscribers keep access after a renewal payment fails. 0 to 30 days."
        className="max-w-xs"
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Repositories</legend>
        {repositories.length === 0 && (
          <p className="text-sm text-gray-600">
            No repositories yet. Connect GitHub on the Repositories page first.
          </p>
        )}
        {listed.map((repository) => (
          <Checkbox
            key={repository.id}
            name="repositories"
            value={repository.id}
            defaultSelected={inOffer.has(repository.id)}
          >
            {repository.name}
            {!repository.sellable && (
              <span className="ml-2 text-sm text-amber-800">
                {repositoryUnavailableReason(repository)}
              </span>
            )}
          </Checkbox>
        ))}
        {unavailable.map((repository) => (
          <Checkbox key={repository.id} name="repositories" value={repository.id} isDisabled>
            {repository.name}
            <span className="ml-2 text-sm">{repositoryUnavailableReason(repository)}</span>
          </Checkbox>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Access level</span>
        <span>Write access</span>
        <span className="text-sm text-gray-600">
          GitHub can't grant read-only access on personal repositories, so subscribers can push.
        </span>
      </div>
      {paddlePrices !== null && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Paddle prices</legend>
          {choosable.length === 0 && unknownSelected.length === 0 && (
            <p className="text-sm text-gray-600">
              No active recurring prices. Add one in Paddle, then refresh the catalog on the Billing
              page.
            </p>
          )}
          {choosable.map((price) => (
            <Checkbox
              key={price.priceId}
              name="paddlePrices"
              value={price.priceId}
              defaultSelected={selectedPrices.has(price.priceId)}
            >
              {priceLabel(price)}
              {price.status !== "active" && (
                <span className="ml-2 text-sm text-amber-800">Archived in Paddle</span>
              )}
            </Checkbox>
          ))}
          {unknownSelected.map((priceId) => (
            <Checkbox key={priceId} name="paddlePrices" value={priceId} defaultSelected>
              {priceId}
              <span className="ml-2 text-sm text-amber-800">Not in the catalog</span>
            </Checkbox>
          ))}
        </fieldset>
      )}
      {paddlePrices === null &&
        offerItems
          .filter((item) => item.source === "paddle")
          .map((item) => (
            // Without the catalog (Paddle disconnected), the offer keeps its prices.
            <input
              key={item.externalItemId}
              type="hidden"
              name="paddlePrices"
              value={item.externalItemId}
            />
          ))}
      {props.simulatedItems && (
        <AriaTextField
          name="items"
          defaultValue={offerItems
            .filter((item) => item.source === "simulated")
            .map((item) => item.externalItemId)
            .join("\n")}
          className="flex flex-col gap-1"
        >
          <Label className="text-sm font-medium">Commercial item IDs</Label>
          <TextArea rows={3} className="rounded border border-gray-300 px-3 py-2 font-mono" />
          <Text slot="description" className="text-sm text-gray-600">
            Simulated items for testing, separated with commas or new lines, for example
            sim_monthly.
          </Text>
        </AriaTextField>
      )}
      {paddlePrices === null && !props.simulatedItems && (
        <p className="text-sm text-gray-600">
          Connect Paddle on the Billing page to choose the prices this offer sells.
        </p>
      )}
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={navigation.state === "submitting"}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {offer === undefined ? "Create offer" : "Save offer"}
        </button>
        {offer !== undefined && (
          <Link to="." className="text-sm underline">
            Cancel editing
          </Link>
        )}
      </div>
    </Form>
  );
}
