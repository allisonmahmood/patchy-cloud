import { describe, expect, it } from "vitest";
import { isWelcomePage } from "./patch-presentation.js";

describe("isWelcomePage", () => {
  it("is a tier 0 patch named welcome or welcome-<n>, and nothing else", () => {
    expect(isWelcomePage({ name: "welcome", tier: 0 })).toBe(true);
    expect(isWelcomePage({ name: "welcome-2", tier: 0 })).toBe(true);
    expect(isWelcomePage({ name: "welcome", tier: 1 })).toBe(false);
    expect(isWelcomePage({ name: "welcome-board", tier: 0 })).toBe(false);
    expect(isWelcomePage({ name: "team-welcome", tier: 0 })).toBe(false);
  });
});
