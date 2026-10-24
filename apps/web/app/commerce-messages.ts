import type {
  CatalogPrice,
  ConnectPaddleResult,
  ManualLinkError,
  ReconnectPaddleResult,
  StartCheckoutResult,
  ViewClaimResult,
} from "@sharerepo/application";
import type { EntitlementState, GrantState } from "@sharerepo/domain";

// User-facing copy for the billing, customers, checkout, claim and "My access" pages. Every map
// is total over its codes, so a raw code is never shown alone. The words are "repository",
// "subscriber" and "purchase".

type ConnectError = Extract<ConnectPaddleResult, { ok: false }>["error"]["reason"];
type ReconnectError = Extract<ReconnectPaddleResult, { ok: false }>["error"]["reason"];

export const PADDLE_NOT_CONFIGURED = "Paddle is not configured in this ShareRepo environment.";
export const PADDLE_UNREACHABLE = "Paddle didn't respond. Try again in a moment.";

/** Why connecting or reconnecting Paddle was refused. `missing` lists missing permissions. */
export function paddleKeyErrorMessage(
  reason: ConnectError | ReconnectError,
  context: { readonly environment: "sandbox" | "live"; readonly missing?: readonly string[] },
): string {
  const messages: Record<ConnectError | ReconnectError, string> = {
    api_key_invalid:
      "That isn't a Paddle API key. Keys start with pdl_live_apikey_ or pdl_sdbx_apikey_.",
    api_key_legacy:
      "That is a legacy Paddle API key, which has no permissions. Create a new API key in Paddle.",
    environment_mismatch:
      context.environment === "live"
        ? "Use a live Paddle API key: this ShareRepo environment sells for real."
        : "Use a sandbox Paddle API key: this ShareRepo environment only accepts sandbox keys.",
    key_refused: "Paddle refused this key. Check that it is active and has not expired.",
    missing_permissions: `The key is missing these permissions: ${(context.missing ?? []).join(", ")}.`,
    already_connected: "Paddle is already connected. Reconnect or disconnect it first.",
    destination_limit:
      "Your Paddle account already has 10 active notification destinations. Deactivate one in Paddle, then try again.",
    not_connected: "Paddle isn't connected.",
    seller_mismatch:
      "This key belongs to a different Paddle account. Disconnect first to connect another account.",
  };
  return messages[reason];
}

/** Why a connection is unauthorized (`status_reason`). */
export function paddleStatusReasonText(reason: string | null): string {
  switch (reason) {
    case "key_refused":
      return "Paddle refused the API key: it was revoked or has expired.";
    case "seller_changed":
      return "The API key now belongs to a different Paddle account.";
    case "permissions_missing":
      return "The API key lost a permission ShareRepo needs.";
    default:
      return "ShareRepo can't use the API key.";
  }
}

export const PADDLE_STATUS_LABELS: Record<"active" | "unauthorized", string> = {
  active: "Active",
  unauthorized: "Needs a new API key",
};

export const MANUAL_LINK_ERRORS: Record<ManualLinkError, string> = {
  reason_required: "Enter a reason of at most 500 characters.",
  login_invalid: "Enter a valid GitHub login.",
  connection_missing: "Connect GitHub first: ShareRepo looks up GitHub accounts through it.",
  login_not_found: "GitHub has no account with that login.",
  account_not_user: "That login is an organization or bot. Subscribers must be personal accounts.",
};

type CheckoutError = Extract<StartCheckoutResult, { ok: false }>["reason"];

export const CHECKOUT_ERRORS: Record<Exclude<CheckoutError, "not_found">, string> = {
  unavailable: "This offer can't be bought right now. Please try again later.",
  price_invalid: "Choose one of the listed prices.",
  no_default_payment_link:
    "Checkout isn't set up yet: the creator needs to set a default payment link in Paddle. Please let them know.",
};

export const CHECKOUT_FAILED = "Paddle couldn't start checkout right now. Try again in a moment.";

type ClaimError = Extract<ViewClaimResult, { ok: false }>["reason"];

export const CLAIM_ERRORS: Record<ClaimError, string> = {
  unknown_claim: "This claim link isn't valid. Request a new one from the creator's claim page.",
  expired: "This claim link has expired. Request a new one from the creator's claim page.",
  already_used: "This claim link has already been used.",
};

export const CLAIM_REQUESTED =
  "If that email address paid for a subscription here, we've sent it a link to claim the purchase. The link works for 24 hours.";

export const CLAIM_EMAIL_UNAVAILABLE =
  "Claiming by email isn't available right now. Ask the creator to link your purchase.";

export const ENTITLEMENT_STATE_LABELS: Record<EntitlementState, string> = {
  active: "Access granted",
  expired: "Access ended",
  revoked: "Access removed",
};

export const GRANT_STATE_LABELS: Record<GrantState, string> = {
  unknown: "Not checked yet",
  absent: "No access on GitHub",
  provisioning: "Inviting…",
  pending_invitation: "Invitation waiting for you",
  active: "Active on GitHub",
  revoking: "Removing…",
  error: "GitHub refused; ShareRepo will retry",
};

// Paddle amounts are in the currency's minor units; these currencies have none.
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW"]);

/** `10.00 USD per month`, `90.00 EUR every 3 months`, or `5.00 USD once`. */
export function priceText(price: CatalogPrice): string {
  const minor = Number(price.unitAmount);
  const amount = ZERO_DECIMAL_CURRENCIES.has(price.currency)
    ? String(minor)
    : (minor / 100).toFixed(2);
  const money = `${amount} ${price.currency}`;
  if (price.billingInterval === null) return `${money} once`;
  const frequency = price.billingFrequency ?? 1;
  return frequency === 1
    ? `${money} per ${price.billingInterval}`
    : `${money} every ${frequency} ${price.billingInterval}s`;
}

/** `Pro plan (Monthly) — 10.00 USD per month`. */
export function priceLabel(price: CatalogPrice): string {
  const name =
    price.description === null || price.description === ""
      ? price.productName
      : `${price.productName} (${price.description})`;
  return `${name} — ${priceText(price)}`;
}
