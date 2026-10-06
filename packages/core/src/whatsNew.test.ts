import { describe, expect, it } from "vitest";
import { releases } from "./whatsNew.js";

// The deploying agent edits the release list by hand; these are the rules a seen marker relies on.
describe("What's new releases", () => {
  it("number releases one above the last, newest first, never skipping or reusing an id", () => {
    expect(releases.map((release) => release.id)).toEqual(
      releases.map((_, index) => releases.length - index)
    );
  });

  it("date each release on a real day, never before the one under it", () => {
    for (const [index, release] of releases.entries()) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${release.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(release.date);
      expect(release.date >= (releases[index + 1]?.date ?? "")).toBe(true);
    }
  });

  it("record the full commit each release was written through, once", () => {
    for (const release of releases) expect(release.through).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(releases.map((release) => release.through)).size).toBe(releases.length);
  });

  it("give every release something to say, and every change its words and PRs", () => {
    for (const release of releases) {
      expect(release.changes.length + release.behindTheScenes.length).toBeGreaterThan(0);
      for (const change of release.changes) {
        expect(change.title.trim()).not.toBe("");
        expect(change.detail.trim()).not.toBe("");
        expect(change.prs.length).toBeGreaterThan(0);
        for (const pr of change.prs) expect(Number.isSafeInteger(pr) && pr > 0).toBe(true);
      }
      for (const line of release.behindTheScenes) expect(line.trim()).not.toBe("");
    }
  });
});
