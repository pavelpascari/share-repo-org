import { describe, expect, it } from "vitest";
import {
  destinationDescription,
  LEGACY_DESTINATION_DESCRIPTION,
  parseDestinationDescription,
} from "../src/index.ts";

// The description ShareRepo gives each Paddle destination it creates, so a sweep can recognise
// its own orphaned destinations and nobody else's.

describe("destination tag", () => {
  const at = Date.parse("2026-10-25T09:30:00.123Z");

  it("describes the workspace and the creation instant, and reads them back", () => {
    const description = destinationDescription({ workspaceId: "ws_01-abc", createdAt: at });
    expect(description).toBe("ShareRepo workspace ws_01-abc created 2026-10-25T09:30:00.123Z");
    expect(description.length).toBeLessThanOrEqual(500);
    expect(parseDestinationDescription(description)).toEqual({
      workspaceId: "ws_01-abc",
      createdAt: at,
    });
  });

  it.each([
    LEGACY_DESTINATION_DESCRIPTION,
    "",
    "Another app",
    "ShareRepo workspace  created 2026-10-25T09:30:00.123Z",
    "ShareRepo workspace a b created 2026-10-25T09:30:00.123Z",
    "ShareRepo workspace ws created 2026-10-25T09:30:00Z",
    "ShareRepo workspace ws created 2026-13-45T09:30:00.123Z",
    "xShareRepo workspace ws created 2026-10-25T09:30:00.123Z",
    "ShareRepo workspace ws created 2026-10-25T09:30:00.123Z ",
    `ShareRepo workspace ${"w".repeat(129)} created 2026-10-25T09:30:00.123Z`,
  ])("does not read %j as ShareRepo's tag", (description) => {
    expect(parseDestinationDescription(description)).toBeNull();
  });

  it("keeps the Phase 5 description for destinations created before the tag", () => {
    expect(LEGACY_DESTINATION_DESCRIPTION).toBe("ShareRepo");
  });
});
