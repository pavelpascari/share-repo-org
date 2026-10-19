import { SIMULATION_ACTIONS, type SimulationError } from "@sharerepo/application";
import {
  ACCESS_DECISION_REASONS,
  GRANT_ERROR_CODES,
  GRANT_STATES,
  type OfferAccessError,
  type OfferInputError,
  RECONCILIATION_ACTIONS,
  RECONCILIATION_REASONS,
  SUBSCRIPTION_STATES,
} from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  accessReasonText,
  checkedText,
  formatDate,
  formatInstant,
  grantErrorText,
  type ObservedRow,
  OFFER_STATUS_LABELS,
  observedAccessText,
  offerErrorMessages,
  parseItemIds,
  plannedActionText,
  repositoryUnavailableReason,
  SIMULATION_ACTION_LABELS,
  SIMULATION_ERRORS,
  SUBSCRIPTION_STATE_LABELS,
} from "../app/entitlement-messages.ts";

// Every code a service or the domain can return maps to a sentence: never a raw code alone.

const OFFER_INPUT_ERRORS: readonly OfferInputError[] = [
  "input_invalid",
  "name_invalid",
  "grace_period_invalid",
  "items_invalid",
  "item_invalid",
  "item_duplicate",
  "accesses_invalid",
  "access_invalid",
  "access_level_invalid",
  "access_required",
  "access_duplicate",
];
const OFFER_ACCESS_ERRORS: readonly OfferAccessError[] = [
  "resource_not_found",
  "resource_not_sellable",
  "access_level_unsupported",
];
const SIMULATION_ERROR_CODES: readonly SimulationError[] = [
  "input_invalid",
  "connection_missing",
  "login_not_found",
  "account_not_user",
  "action_invalid",
  "invalid_transition",
];

const isSentence = (text: string | undefined, code: string) => {
  expect(text, code).toEqual(expect.any(String));
  expect(text, code).not.toBe(code);
  expect(text, code).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
};

describe("offer error messages", () => {
  it("are total over every input and access error, naming the repository", () => {
    const names = new Map([["r1", "octo/course"]]);
    for (const code of OFFER_INPUT_ERRORS) {
      const [message] = offerErrorMessages([{ field: "input", code }], names);
      isSentence(message, code);
    }
    for (const code of OFFER_ACCESS_ERRORS) {
      const [message] = offerErrorMessages([{ field: "access", resourceId: "r1", code }], names);
      isSentence(message, code);
      expect(message).toMatch(/^octo\/course /);
      const [unnamed] = offerErrorMessages([{ field: "access", resourceId: "r9", code }], names);
      expect(unnamed).toMatch(/^A repository /);
    }
    expect(
      offerErrorMessages(
        [
          { field: "items", code: "item_taken" },
          { field: "offer", code: "offer_archived" },
        ],
        names,
      ),
    ).toEqual([
      "One of these commercial item IDs is already used by another offer.",
      "This offer is archived and can't be edited.",
    ]);
  });
});

describe("access messages", () => {
  it("describe every decision reason, with a fallback for unknown stored codes", () => {
    for (const reason of ACCESS_DECISION_REASONS) isSentence(accessReasonText(reason), reason);
    expect(accessReasonText("from_the_future")).toBe("Unrecognized reason");
  });

  it("explain every grant error code with what to do, with a fallback for unknown codes", () => {
    const seen = new Set<string>();
    for (const code of GRANT_ERROR_CODES) {
      const { message, hint } = grantErrorText(code);
      isSentence(message, code);
      isSentence(hint, code);
      seen.add(message);
    }
    expect(seen.size).toBe(GRANT_ERROR_CODES.length);
    const fallback = grantErrorText("from_the_future");
    expect(fallback).toEqual({
      message: "The last change on GitHub failed",
      hint: "Press Retry, or wait for the next check.",
    });
    expect(grantErrorText(null)).toEqual(fallback);
    expect(grantErrorText("rate_limited").message).toBe("GitHub's rate limit was reached");
  });

  it("describe what GitHub shows for every grant state", () => {
    const NOW = Date.UTC(2026, 9, 19, 14, 5);
    const grant: NonNullable<ObservedRow["grant"]> = {
      state: "active",
      managed: true,
      indirect: false,
      observedAt: NOW - 5 * 60_000,
      expiresAt: null,
      lastErrorCode: null,
      nextAttemptAt: null,
    };
    const row = (fields: Partial<ObservedRow["grant"] & object> | null, entitled = true) =>
      ({
        subjectLogin: "octo",
        entitled,
        resourceLastReconciledAt: null,
        grant: fields === null ? null : { ...grant, ...fields },
      }) satisfies ObservedRow;
    const label = (fields: Partial<ObservedRow["grant"] & object> | null, entitled = true) =>
      observedAccessText(row(fields, entitled), NOW).label;

    for (const state of GRANT_STATES) isSentence(label({ state }), state);
    expect(label(null)).toBe("Not checked yet");
    expect(label({ state: "unknown" })).toBe("Not checked yet");
    expect(label({ state: "active" })).toBe("Active");
    expect(label({ state: "provisioning" })).toBe("Inviting…");
    expect(label({ state: "revoking" })).toBe("Removing…");
    expect(label({ state: "absent" }, false)).toBe("Removed");
    expect(label({ state: "absent" }, true)).toBe("No access");
    const expires = Date.UTC(2026, 9, 26, 9, 0);
    expect(label({ state: "pending_invitation", expiresAt: expires })).toBe(
      "Invitation sent, waiting for @octo to accept (expires 2026-10-26)",
    );
    expect(label({ state: "pending_invitation" })).toBe(
      "Invitation sent, waiting for @octo to accept",
    );
    expect(label({ state: "pending_invitation", expiresAt: NOW })).toBe("Invitation expired");
    for (const state of ["active", "pending_invitation"] as const) {
      expect(label({ state, managed: false })).toBe("Has access ShareRepo does not manage");
      expect(label({ state, managed: false, indirect: true })).toBe(
        "Has access as the repository owner",
      );
    }
    // Only listed access is someone else's: a removal in progress is still ShareRepo's.
    expect(label({ state: "absent", managed: false }, false)).toBe("Removed");

    const failed = observedAccessText(
      row({ state: "error", lastErrorCode: "rate_limited", nextAttemptAt: NOW + 60 * 60_000 }),
      NOW,
    );
    expect(failed).toEqual({
      label: "Error: GitHub's rate limit was reached",
      hint: "ShareRepo waits until GitHub allows more changes, then tries again.",
      retry: "Retrying at 2026-10-19 15:05 UTC",
      checked: "Checked 5 min ago",
    });
    expect(
      observedAccessText(row({ state: "error", lastErrorCode: "invitation_rejected" }), NOW),
    ).toMatchObject({ label: "Error: GitHub refused the invitation", retry: null });
    expect(label({ state: "error", lastErrorCode: "mystery" })).toBe(
      "Error: The last change on GitHub failed",
    );
  });

  it("say when access was last checked, from the grant or the repository", () => {
    const NOW = Date.UTC(2026, 9, 19, 14, 5);
    const at = (observedAt: number | null, resourceLastReconciledAt: number | null) =>
      observedAccessText(
        {
          subjectLogin: "octo",
          entitled: true,
          resourceLastReconciledAt,
          grant: {
            state: "active",
            managed: true,
            indirect: false,
            observedAt,
            expiresAt: null,
            lastErrorCode: null,
            nextAttemptAt: null,
          },
        },
        NOW,
      ).checked;
    expect(at(null, null)).toBeNull();
    expect(at(NOW - 2 * 60_000, null)).toBe("Checked 2 min ago");
    expect(at(null, NOW - 30_000)).toBe("Checked just now");
    // The later of the two.
    expect(at(NOW - 90 * 60_000, NOW - 3 * 60_000)).toBe("Checked 3 min ago");
    expect(
      observedAccessText(
        { subjectLogin: "octo", entitled: true, resourceLastReconciledAt: NOW, grant: null },
        NOW,
      ),
    ).toEqual({ label: "Not checked yet", hint: null, retry: null, checked: "Checked just now" });

    expect(checkedText(NOW - 59 * 60_000, NOW)).toBe("Checked 59 min ago");
    expect(checkedText(NOW - 60 * 60_000, NOW)).toBe("Checked 2026-10-19 13:05 UTC");
    // A clock that is slightly behind never shows a negative age.
    expect(checkedText(NOW + 5_000, NOW)).toBe("Checked just now");
    expect(formatDate(Date.UTC(2026, 9, 26, 23, 59))).toBe("2026-10-26");
  });

  it("describe every planned action with every reason", () => {
    for (const action of RECONCILIATION_ACTIONS) {
      for (const reason of RECONCILIATION_REASONS) {
        const { label, detail } = plannedActionText(action, reason);
        isSentence(label, action);
        isSentence(detail, reason);
        expect(detail.charAt(0)).toBe(detail.charAt(0).toUpperCase());
      }
    }
    expect(plannedActionText("provision", "grant_missing")).toEqual({
      label: "Will invite",
      detail: "No access yet",
    });
    expect(plannedActionText("noop", "no_access").label).toBe("Nothing to do");
    expect(plannedActionText("blocked", "resource_unavailable").label).toBe(
      "Blocked: repository not sellable",
    );
  });

  it("say what a wait is for, and when a retry is due", () => {
    const at = Date.UTC(2026, 9, 19, 14, 5);
    const wait = (reason: Parameters<typeof plannedActionText>[1], retryAt?: number) =>
      plannedActionText("wait", reason, retryAt).label;
    expect(wait("invitation_pending")).toBe("Waiting for the subscriber to accept");
    expect(wait("invitation_quota")).toBe("Waiting: invitation limit for this repository reached");
    expect(wait("transient_error")).toBe("Waiting to retry");
    expect(wait("rate_limited", at)).toBe("Waiting to retry at 2026-10-19 14:05 UTC");
    expect(wait("transient_error", at)).toBe("Waiting to retry at 2026-10-19 14:05 UTC");
    expect(wait("invitation_quota", at)).toBe(
      "Waiting: invitation limit for this repository reached",
    );
    expect(wait("intermediate_state")).toBe("Waiting");
    // A retry time only qualifies a wait.
    expect(plannedActionText("retry", "rate_limited", at).label).toBe("Will retry");
  });
});

describe("simulator messages", () => {
  it("label every action, state and error", () => {
    for (const action of SIMULATION_ACTIONS) isSentence(SIMULATION_ACTION_LABELS[action], action);
    for (const state of SUBSCRIPTION_STATES) isSentence(SUBSCRIPTION_STATE_LABELS[state], state);
    for (const code of SIMULATION_ERROR_CODES) isSentence(SIMULATION_ERRORS[code], code);
    expect(SIMULATION_ACTION_LABELS.mark_past_due).toBe("Mark past due");
    expect(SIMULATION_ACTION_LABELS.cancel_at_period_end).toBe("Cancel at period end");
  });
});

describe("helpers", () => {
  it("label offer statuses", () => {
    expect(OFFER_STATUS_LABELS).toEqual({ active: "Active", archived: "Archived" });
  });

  it("explain why a repository can't be sold", () => {
    const base = {
      id: "r",
      name: "octo/r",
      private: true,
      archived: false,
      selection: "selected",
      sellable: true,
      accessLevels: ["write"],
    } as const;
    expect(repositoryUnavailableReason(base)).toBeNull();
    const unsellable = { ...base, sellable: false };
    expect(repositoryUnavailableReason({ ...unsellable, selection: "removed" })).toBe(
      "Removed from the GitHub App",
    );
    expect(repositoryUnavailableReason({ ...unsellable, archived: true })).toBe(
      "Archived on GitHub",
    );
    expect(repositoryUnavailableReason({ ...unsellable, private: false })).toBe(
      "Public: not sellable",
    );
    expect(repositoryUnavailableReason(unsellable)).toBe("GitHub connection not active");
  });

  it("split item IDs on commas, spaces and lines", () => {
    expect(parseItemIds(" sim_a,sim_b\n\nsim_c ,  ")).toEqual(["sim_a", "sim_b", "sim_c"]);
    expect(parseItemIds("")).toEqual([]);
  });

  it("format instants in UTC", () => {
    expect(formatInstant(Date.UTC(2026, 9, 19, 14, 5, 59))).toBe("2026-10-19 14:05 UTC");
  });
});
