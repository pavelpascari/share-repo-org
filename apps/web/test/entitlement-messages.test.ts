import { SIMULATION_ACTIONS, type SimulationError } from "@sharerepo/application";
import {
  ACCESS_DECISION_REASONS,
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
  formatInstant,
  GRANT_STATE_LABELS,
  OFFER_STATUS_LABELS,
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

  it("label every grant state", () => {
    for (const state of GRANT_STATES) isSentence(GRANT_STATE_LABELS[state], state);
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
