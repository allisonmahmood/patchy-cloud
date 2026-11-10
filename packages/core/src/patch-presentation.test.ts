import { describe, expect, it } from "vitest";
import { isWelcomePage, patchTitle, recovery, recoveryLine } from "./patch-presentation.js";

describe("patchTitle", () => {
  const patch = (title: string) => ({ name: "new-business", title });

  it("leaves out the company its own HTML names after the title", () => {
    for (const title of [
      "New Business · Brightline Studio",
      "New Business | brightline studio",
      "New Business – Brightline Studio",
      "New Business - Brightline Studio",
      "  New Business · Brightline Studio  "
    ])
      expect(patchTitle(patch(title), "Brightline Studio")).toBe("New Business");
    expect(patchTitle(patch("Deals · Pipeline · Brightline Studio"), "Brightline Studio")).toBe(
      "Deals · Pipeline"
    );
    // A company whose own name holds a separator.
    for (const company of ["Harbor - Pine", "Harbor | Pine", "Harbor · Pine"])
      expect(patchTitle(patch(`Pipeline · ${company}`), company)).toBe("Pipeline");
  });

  it("keeps a title whose last part is anything else, and falls back to the name", () => {
    expect(patchTitle(patch("Pitch · Library"), "Brightline Studio")).toBe("Pitch · Library");
    expect(patchTitle(patch("Brightline Studio"), "Brightline Studio")).toBe("Brightline Studio");
    expect(patchTitle(patch("Pipeline · Pine"), "Harbor - Pine")).toBe("Pipeline · Pine");
    expect(patchTitle(patch("NewBrightline Studio"), "Brightline Studio")).toBe(
      "NewBrightline Studio"
    );
    expect(patchTitle(patch("New Business · Harbor Works"), "Brightline Studio")).toBe(
      "New Business · Harbor Works"
    );
    expect(patchTitle(patch("  "), "Brightline Studio")).toBe("new-business");
  });
});

describe("isWelcomePage", () => {
  it("is a page named welcome or welcome-<n>, and nothing else", () => {
    expect(isWelcomePage({ name: "welcome", tier: 1 })).toBe(true);
    expect(isWelcomePage({ name: "welcome-2", tier: 1 })).toBe(true);
    expect(isWelcomePage({ name: "welcome", tier: 2 })).toBe(false);
    expect(isWelcomePage({ name: "welcome-board", tier: 1 })).toBe(false);
    expect(isWelcomePage({ name: "team-welcome", tier: 1 })).toBe(false);
  });
});

describe("recovery", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const deleted = (purgeAt: string | null) =>
    recovery({
      state: "deleted",
      actorName: "Sam <S>",
      stateAt: "2026-11-05T09:00:00.000Z",
      purgeAt,
      now
    });

  it("can always bring back a retired patch, and says so", () => {
    const state = recovery({
      state: "retired",
      actorName: null,
      stateAt: "2026-11-05T09:00:00.000Z",
      purgeAt: null,
      now
    });
    expect(state).toMatchObject({ restorable: true, reclaimAt: null, daysLeft: null });
    expect(recoveryLine(state)).toBe(
      'Retired on <time datetime="2026-11-05T09:00:00.000Z">5 Nov 2026</time>. Nobody can open it until it’s restored.'
    );
  });

  it("counts a deleted patch's days to its reclaim date, then says it can't come back", () => {
    const open = deleted(new Date(now + 3 * day - 1).toISOString());
    expect(open).toMatchObject({ restorable: true, daysLeft: 3 });
    expect(recoveryLine(open)).toBe(
      'Deleted by Sam &lt;S&gt; on <time datetime="2026-11-05T09:00:00.000Z">5 Nov 2026</time>. Gone for good on <time datetime="2026-11-11T11:59:59.999Z">11 Nov 2026</time> unless restored.'
    );
    for (const ended of [deleted(new Date(now).toISOString()), deleted(null)]) {
      expect(ended).toMatchObject({ restorable: false, daysLeft: 0 });
      expect(recoveryLine(ended)).toContain(
        "The recovery window has ended, so it can no longer be restored."
      );
    }
  });
});
