import { OUTBOX_KINDS } from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  affectedText,
  JOB_KIND_LABELS,
  jobErrorText,
  reconcileErrorText,
} from "../app/failure-messages.ts";

describe("failure messages", () => {
  it("labels every job kind", () => {
    for (const kind of OUTBOX_KINDS) expect(JOB_KIND_LABELS[kind]).toMatch(/^[A-Z]/);
  });

  it("explains known codes and shows unknown ones after a sentence", () => {
    expect(jobErrorText("dead_lettered")).toBe("It kept failing and its retries ran out.");
    expect(jobErrorText("weird_code")).toBe("It failed (weird_code).");
    expect(jobErrorText(null)).toBe("It failed.");
    expect(reconcileErrorText("installation_missing")).toBe(
      "The GitHub App is no longer installed.",
    );
    expect(reconcileErrorText("other")).toBe("The last checks failed (other).");
    expect(reconcileErrorText(null)).toBe("The last checks failed.");
  });

  it("names the affected access in repository-centric words", () => {
    const none = { repositories: [], subscribers: [], offers: [], connection: null, event: null };
    expect(affectedText(none)).toEqual([]);
    expect(
      affectedText({
        repositories: ["octo/a"],
        subscribers: ["mona"],
        offers: ["Pro"],
        connection: { provider: "github", name: "octo" },
        event: { provider: "paddle", type: "subscription.updated" },
      }),
    ).toEqual([
      "Repository octo/a",
      "Subscriber mona",
      "Offer Pro",
      "GitHub connection octo",
      "Paddle event subscription.updated",
    ]);
    expect(
      affectedText({
        ...none,
        repositories: ["octo/a", "octo/b"],
        subscribers: ["mona", "lisa"],
        offers: ["Pro", "Team"],
        connection: { provider: "paddle", name: "Acme" },
        event: { provider: "github", type: "installation" },
      }),
    ).toEqual([
      "Repositories octo/a, octo/b",
      "Subscribers mona, lisa",
      "Offers Pro, Team",
      "Paddle connection Acme",
      "GitHub event installation",
    ]);
  });
});
