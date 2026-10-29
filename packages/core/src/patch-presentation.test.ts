import { describe, expect, it } from "vitest";
import { isWelcomePage } from "./patch-presentation.js";

describe("isWelcomePage", () => {
  it("is a page named welcome or welcome-<n>, and nothing else", () => {
    expect(isWelcomePage({ name: "welcome", tier: 1 })).toBe(true);
    expect(isWelcomePage({ name: "welcome-2", tier: 1 })).toBe(true);
    // Tier 0 rows are pages until they become tier 1.
    expect(isWelcomePage({ name: "welcome", tier: 0 })).toBe(true);
    expect(isWelcomePage({ name: "welcome", tier: 2 })).toBe(false);
    expect(isWelcomePage({ name: "welcome-board", tier: 1 })).toBe(false);
    expect(isWelcomePage({ name: "team-welcome", tier: 1 })).toBe(false);
  });
});
