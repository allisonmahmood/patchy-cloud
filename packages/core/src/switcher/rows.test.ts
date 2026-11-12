import { describe, expect, it } from "vitest";
import type { Kept } from "./cache.js";
import type { SwitcherList } from "./list.js";
import { hold, litAtOpen, type Section, sections, sinceLabel } from "./rows.js";

// Friday 6 November 2026, noon, in the test's own time zone.
const now = new Date(2026, 10, 6, 12, 0).getTime();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const list: SwitcherList = {
  viewer: { id: "usr_jonah", companyId: "cmp_ns", role: "member" },
  company: { handle: "northsound", name: "Northsound" },
  whatsNewUnseen: 3,
  patches: [
    {
      id: "crew",
      name: "crew-rota",
      title: "Crew Rota",
      tier: 2,
      mine: true,
      openedAt: ago(0),
      score: 9
    },
    {
      id: "sail",
      name: "sailings-today",
      // Rows leave out the company a patch's own HTML ends its title with.
      title: "Sailings Today · Northsound",
      tier: 2,
      mine: false,
      openedAt: ago(4),
      score: 3
    },
    {
      id: "sales",
      name: "sales-hq",
      title: "Sales HQ",
      tier: 2,
      mine: false,
      openedAt: ago(60),
      score: 5
    },
    {
      id: "vessel",
      name: "vessel-maintenance",
      title: "",
      tier: 2,
      mine: false,
      openedAt: ago(1500),
      score: 2
    },
    {
      id: "fuel",
      name: "fuel-log",
      title: "Fuel Log",
      tier: 2,
      mine: true,
      openedAt: ago(1560),
      score: 1
    },
    {
      id: "cargo",
      name: "cargo-bookings",
      title: "Cargo Bookings",
      tier: 2,
      mine: false,
      openedAt: ago(4000),
      score: 1
    },
    {
      id: "time",
      name: "summer-timetable",
      title: "Summer timetable",
      tier: 1,
      mine: false,
      openedAt: ago(4100)
    },
    { id: "safety", name: "safety-drills", title: "Safety Drills", tier: 2, mine: false }
  ],
  shared: [
    {
      id: "galley",
      company: { handle: "pine", name: "Pine Studio" },
      name: "galley-orders",
      title: "Galley Orders | Pine Studio",
      tier: 2
    }
  ]
};
const kept = (extra: Partial<Kept> = {}): Kept => ({
  viewer: "usr_jonah",
  company: "cmp_ns",
  list,
  savedAt: now,
  ...extra
});
const view = (result: ReadonlyArray<Section>) =>
  result.map((section) => [section.label ?? "", section.rows.map((row) => row.title)]);

describe("what the switcher lists", () => {
  it("over a patch: the flip back, the next five, This patch and Patchy", () => {
    const result = sections(
      kept({ current: "crew", previous: "sail" }),
      { patch: "crew", path: "/northsound/crew-rota" },
      "",
      now
    );
    expect(view(result)).toEqual([
      [
        "",
        [
          "Sailings Today",
          "Sales HQ",
          "vessel-maintenance",
          "Fuel Log",
          "Cargo Bookings",
          "Summer timetable"
        ]
      ],
      ["This patch", ["Overview", "Versions", "Log", "Settings"]],
      [
        "Patchy",
        [
          "Home",
          "All patches",
          "Your agents",
          "Teams",
          "People",
          "Integrations",
          "Agent access",
          "What’s new"
        ]
      ]
    ]);
    const [first] = result[0]!.rows;
    expect(first).toMatchObject({ href: "/northsound/sailings-today", detail: "4 min" });
    expect(result[1]!.rows.map((row) => row.href)).toEqual([
      "/patches/crew-rota",
      "/patches/crew-rota/versions",
      "/patches/crew-rota/log",
      "/patches/crew-rota/settings"
    ]);
    expect(result[2]!.rows.at(-1)).toMatchObject({ href: "/whats-new", dot: true });
  });

  it("flips to the tab's previous patch, wherever it sits by last open", () => {
    const result = sections(
      kept({ current: "sail", previous: "cargo" }),
      { patch: "sail", path: "/northsound/sailings-today" },
      "",
      now
    );
    expect(result[0]!.rows.map((row) => row.title)).toEqual([
      "Cargo Bookings",
      "Crew Rota",
      "Sales HQ",
      "vessel-maintenance",
      "Fuel Log",
      "Summer timetable"
    ]);
  });

  it("on a portal page, flips to the patch the tab left, and leaves the page's own place out", () => {
    const result = sections(kept({ current: "fuel", previous: "crew" }), { path: "/" }, "", now);
    expect(result[0]!.rows[0]!.title).toBe("Fuel Log");
    expect(view(result).at(-1)).toEqual([
      "Patchy",
      [
        "All patches",
        "Your agents",
        "Teams",
        "People",
        "Integrations",
        "Agent access",
        "What’s new"
      ]
    ]);
    expect(result.some((section) => section.label === "This patch")).toBe(false);
  });

  it("without a pointer, flips to the patch opened last other than this one, and never lists this one", () => {
    const result = sections(kept(), { patch: "crew", path: "/northsound/crew-rota" }, "", now);
    expect(result[0]!.rows[0]!.title).toBe("Sailings Today");
    expect(result.flatMap((section) => section.rows).some((row) => row.key === "patch:crew")).toBe(
      false
    );
    // A pointer to a patch no longer listed is passed over.
    const gone = sections(
      kept({ current: "crew", previous: "retired" }),
      { patch: "crew", path: "/" },
      "",
      now
    );
    expect(gone[0]!.rows[0]!.title).toBe("Sailings Today");
  });

  it("gives a guest no This patch, and flips back to a shared patch by its own company's address", () => {
    const result = sections(
      kept({ current: "galley", previous: "crew" }),
      { patch: "crew", path: "/" },
      "",
      now
    );
    expect(result[0]!.rows[0]).toMatchObject({
      title: "Galley Orders",
      href: "/pine/galley-orders",
      detail: "Pine Studio"
    });
    const over = sections(
      kept({ current: "galley", previous: "crew" }),
      { patch: "galley", path: "/pine/galley-orders" },
      "",
      now
    );
    expect(over.map((section) => section.label)).toEqual([undefined, "Patchy"]);
  });

  it("gives an admin Log and Settings on a colleague's patch, and a member only Overview and Versions", () => {
    const here = { patch: "sail", path: "/northsound/sailings-today" };
    const cards = (role: "member" | "admin") =>
      sections(kept({ list: { ...list, viewer: { ...list.viewer, role } } }), here, "", now)
        .find((section) => section.label === "This patch")!
        .rows.map((row) => row.title);
    expect(cards("member")).toEqual(["Overview", "Versions"]);
    expect(cards("admin")).toEqual(["Overview", "Versions", "Log", "Settings"]);
  });

  it("with no list yet, or none at all, lists Patchy's places", () => {
    const result = sections(
      { viewer: "usr_jonah", company: "cmp_ns", current: "crew" },
      { patch: "sail", path: "/" },
      "",
      now
    );
    expect(view(result)).toEqual([
      [
        "Patchy",
        [
          "All patches",
          "Your agents",
          "Teams",
          "People",
          "Integrations",
          "Agent access",
          "What’s new"
        ]
      ]
    ]);
    expect(result[0]!.rows.at(-1)!.dot).toBe(false);
  });

  it("typed, filters everything into one ranked list", () => {
    const here = { patch: "crew", path: "/northsound/crew-rota" };
    expect(view(sections(kept(), here, "sa", now))).toEqual([
      ["", ["Sales HQ", "Sailings Today", "Safety Drills"]]
    ]);
    // A patch's own Settings leads; the sidebar's Settings opens People, which answers to it.
    expect(view(sections(kept(), here, "set", now))).toEqual([["", ["Settings", "People"]]]);
    expect(view(sections(kept(), { path: "/agents" }, "settings", now))).toEqual([
      ["", ["People"]]
    ]);
    expect(view(sections(kept(), here, "go", now))).toEqual([["", ["Galley Orders"]]]);
    expect(view(sections(kept(), here, "peo", now))).toEqual([["", ["People"]]]);
    // Every place with a page is listed, Settings' by their own names.
    expect(view(sections(kept(), here, "agent", now))).toEqual([
      ["", ["Agent access", "Your agents"]]
    ]);
    expect(sections(kept(), here, "payroll", now)).toEqual([]);
  });
});

describe("patches never opened, with nothing typed", () => {
  const patch = (id: string, title: string, openedAt?: string) => ({
    id,
    name: id,
    title,
    tier: 2,
    mine: false,
    ...(openedAt === undefined ? {} : { openedAt, score: 1 })
  });
  const shared = (id: string, title: string) => ({
    id,
    company: { handle: "pine", name: "Pine Studio" },
    name: id,
    title,
    tier: 2
  });
  const of = (patches: SwitcherList["patches"], sharedWith: SwitcherList["shared"] = []): Kept => ({
    viewer: "usr_jonah",
    company: "cmp_ns",
    list: { ...list, patches, shared: sharedWith },
    savedAt: now
  });
  const first = (result: ReadonlyArray<Section>) => result[0]!;

  it("fill a new member's menu, up to six by title, with none of them lit", () => {
    const result = sections(
      of(
        ["Tide", "anchor", "Ballast", "Crew", "Deck", "Engine", "Fuel", "Galley"].map((title) =>
          patch(title.toLowerCase(), title)
        )
      ),
      { path: "/" },
      "",
      now
    );
    expect(first(result).rows.map((row) => row.title)).toEqual([
      "anchor",
      "Ballast",
      "Crew",
      "Deck",
      "Engine",
      "Fuel"
    ]);
    expect(first(result).rows.every((row) => row.detail === undefined)).toBe(true);
    expect(first(result).quiet).toBe(true);
    // The menu opens on Patchy's first place, as before any patch was listed.
    expect(result.flatMap((section) => section.rows)[litAtOpen(result)]!.title).toBe("All patches");
  });

  it("show a guest the patches shared with them, named with their company", () => {
    const result = sections(
      of([], [shared("s2", "Onboard Menu"), shared("s1", "Galley Orders")]),
      { path: "/patches" },
      "",
      now
    );
    expect(first(result).rows.map((row) => [row.title, row.detail])).toEqual([
      ["Galley Orders", "Pine Studio"],
      ["Onboard Menu", "Pine Studio"]
    ]);
    expect(first(result).quiet).toBe(true);
    expect(result.flatMap((section) => section.rows)[litAtOpen(result)]!.title).toBe("Home");
  });

  it("come after the flip and every opened patch, the company's before the shared, six in all", () => {
    const result = sections(
      {
        ...of(
          [
            patch("crew", "Crew Rota", ago(0)),
            patch("sail", "Sailings Today", ago(30)),
            patch("fuel", "Fuel Log", ago(90)),
            patch("zinc", "Zinc Stock"),
            patch("bunk", "Bunk Plan"),
            patch("tide", "Tide Tables")
          ],
          [shared("s1", "Galley Orders"), shared("s2", "Allergens")]
        ),
        current: "crew",
        previous: "fuel"
      },
      { patch: "crew", path: "/northsound/crew-rota" },
      "",
      now
    );
    expect(first(result).rows.map((row) => row.title)).toEqual([
      "Fuel Log",
      "Sailings Today",
      "Bunk Plan",
      "Tide Tables",
      "Zinc Stock",
      "Allergens"
    ]);
    expect(first(result).quiet).toBeUndefined();
    expect(litAtOpen(result)).toBe(0);
  });

  it("keep the rows an open menu shows when a refresh brings one that sorts ahead", () => {
    const six = ["Bunk", "Crew", "Deck", "Engine", "Fuel", "Galley"].map((title) =>
      patch(title.toLowerCase(), title)
    );
    const here = { path: "/" };
    const before = sections(of(six), here, "", now);
    const shown = before.flatMap((section) => section.rows.map((row) => row.key));
    // Galley, the sixth, is lit; Anchor arrives and sorts first.
    const after = hold(
      sections(of([patch("anchor", "Anchor"), ...six]), here, "", now, shown),
      shown
    );
    expect(first(after).rows.map((row) => row.title)).toEqual([
      "Bunk",
      "Crew",
      "Deck",
      "Engine",
      "Fuel",
      "Galley"
    ]);
    // A row that is gone frees its slot for the newcomer.
    const gone = hold(
      sections(of([patch("anchor", "Anchor"), ...six.slice(0, 5)]), here, "", now, shown),
      shown
    );
    expect(first(gone).rows.map((row) => row.title)).toEqual([
      "Bunk",
      "Crew",
      "Deck",
      "Engine",
      "Fuel",
      "Anchor"
    ]);
  });

  it("still never list the patch on screen", () => {
    const result = sections(
      of([patch("crew", "Crew Rota"), patch("deck", "Deck Log")]),
      { patch: "crew", path: "/northsound/crew-rota" },
      "",
      now
    );
    expect(first(result).rows.map((row) => row.title)).toEqual(["Deck Log"]);
  });
});

describe("a refresh while the menu is open", () => {
  it("keeps the rows shown in their order and adds new ones at the end of their section", () => {
    const row = (key: string) => ({
      key,
      href: `/${key}`,
      title: key,
      mark: { icon: "home" as const }
    });
    const next: Section[] = [
      { rows: [row("c"), row("new"), row("a")] },
      { label: "Patchy", rows: [row("y"), row("x")] }
    ];
    expect(view(hold(next, ["a", "b", "c", "x", "y"]))).toEqual([
      ["", ["a", "c", "new"]],
      ["Patchy", ["x", "y"]]
    ]);
  });
});

describe("when the viewer last opened it", () => {
  it("reads as a person would say it", () => {
    const at = (date: Date) => sinceLabel(date.getTime(), now);
    expect(sinceLabel(now - 20_000, now)).toBe("now");
    expect(sinceLabel(now - 4 * 60_000, now)).toBe("4 min");
    expect(sinceLabel(now - 61 * 60_000, now)).toBe("1 h");
    expect(at(new Date(2026, 10, 5, 23, 0))).toBe("Yesterday");
    expect(at(new Date(2026, 10, 2, 9, 0))).toBe("Mon");
    expect(at(new Date(2026, 9, 16, 9, 0))).toBe("3 wk");
    expect(at(new Date(2026, 9, 2, 9, 0))).toBe("Oct 2");
    expect(at(new Date(2025, 9, 2, 9, 0))).toBe("Oct 2, 2025");
  });
});
