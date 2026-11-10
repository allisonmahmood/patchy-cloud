import { describe, expect, it } from "vitest";
import { changesSince } from "./whatsNew.js";
import { entriesSince, monthHref, permalink } from "./whatsNewLinks.js";

// Permalinks are shared and bookmarked, so their shape is a promise.
describe("What's new addresses", () => {
  it("put a change on its month's page, named by its release and place", () => {
    expect(permalink({ id: 40, date: "2026-11-08" }, 1)).toBe("/whats-new/2026-11#change-40-1");
    expect(permalink({ id: 40, date: "2026-11-08" }, 1, 38)).toBe(
      "/whats-new/2026-11?since=38#change-40-1"
    );
    expect(monthHref()).toBe("/whats-new");
    expect(monthHref(undefined, 38)).toBe("/whats-new?since=38");
  });

  it("list the same changes as changesSince, each with where it shipped", () => {
    for (const seen of [0, 20]) {
      const entries = entriesSince(seen);
      expect(entries.map(({ change }) => change)).toEqual(changesSince(seen));
      for (const { release, n, change } of entries) expect(release.changes[n]).toBe(change);
    }
  });
});
