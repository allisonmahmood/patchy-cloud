import { describe, expect, it } from "vitest";
import { matchTier, rank } from "./rank.js";

const patch = (id: string, title: string, name: string, score?: number) => ({
  id,
  title,
  name,
  score
});
const northsound = [
  patch("p1", "Sailings Today", "sailings-today", 3),
  patch("p2", "Sales HQ", "sales-hq", 5),
  patch("p3", "Safety Drills", "safety-drills", 1),
  patch("p4", "Q4 sales kickoff", "q4-sales-kickoff", 0.5),
  patch("p5", "Stock Adjustments", "stock-adjustments"),
  patch("p6", "Crew Rota", "crew-rota", 9),
  patch("p7", "Vessel Maintenance", "vessel-maintenance", 2)
];
const titles = (query: string) => rank(query, northsound).map(({ title }) => title);

describe("rank", () => {
  it("matches word starts in any order, then initials, by open score within a tier", () => {
    expect(titles("sa")).toEqual([
      "Sales HQ",
      "Sailings Today",
      "Safety Drills",
      "Q4 sales kickoff",
      "Stock Adjustments"
    ]);
    expect(titles("hq sales")).toEqual(["Sales HQ"]);
    expect(titles("sh")).toEqual(["Sales HQ"]);
    expect(titles("vm")).toEqual(["Vessel Maintenance"]);
  });

  it("reads the name too, and folds case and accents", () => {
    expect(titles("ROTA")).toEqual(["Crew Rota"]);
    expect(matchTier("cafe", { id: "c", title: "Café orders" })).toBe("word");
    expect(matchTier("kick", { id: "k", title: "", name: "q4-sales-kickoff" })).toBe("word");
  });

  it("matches inside a word only from three letters, below every other tier", () => {
    expect(titles("ota")).toEqual(["Crew Rota"]);
    expect(titles("ot")).toEqual([]);
    expect(matchTier("dri", northsound[2]!)).toBe("word");
    expect(matchTier("rill", northsound[2]!)).toBe("inside");
    // An exact word start outranks a busier patch matched inside a word.
    expect(
      rank("rew", [patch("a", "Crew Rota", "crew-rota", 50), patch("b", "Rewards", "rewards")]).map(
        ({ id }) => id
      )
    ).toEqual(["b", "a"]);
  });

  it("has no typo tolerance and needs every typed word", () => {
    expect(titles("slaes")).toEqual([]);
    expect(titles("sales zzz")).toEqual([]);
    expect(titles("  ")).toEqual([]);
  });

  it("breaks ties by title, then id, the same every time", () => {
    const tied = [
      patch("b", "Notes", "notes-b"),
      patch("a", "Notes", "notes-a"),
      patch("c", "nets", "nets")
    ];
    expect(rank("n", tied).map(({ id }) => id)).toEqual(["c", "a", "b"]);
    expect(rank("n", tied.toReversed()).map(({ id }) => id)).toEqual(["c", "a", "b"]);
  });
});
