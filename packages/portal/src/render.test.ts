import { describe, expect, it } from "vitest";
import { firstClause } from "./render.js";

describe("firstClause", () => {
  it.each([
    ["Find a desk. Keep the second sentence on the card.", "Find a desk"],
    ["Choose lunch; keep this detail on the card.", "Choose lunch"],
    ["Book a room – keep this detail on the card.", "Book a room"],
    ["Plan the day; next clause. Last clause – still later", "Plan the day"],
    ["Wait for it... then keep this detail on the card.", "Wait for it"],
    ["a".repeat(81), `${"a".repeat(79)}…`],
    [".NET release health and deployment notes", ".NET release health and deployment notes"],
    ["Track release 1.2 rollouts", "Track release 1.2 rollouts"]
  ])("cuts %j to %j", (description, clause) => {
    expect(firstClause(description)).toBe(clause);
  });
});
