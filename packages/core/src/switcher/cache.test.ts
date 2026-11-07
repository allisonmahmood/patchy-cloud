import { describe, expect, it } from "vitest";
import { arrive, forgetKept, readKept, writeKept } from "./cache.js";
import type { SwitcherList } from "./list.js";

/** A tab's storage, in memory, that can refuse like a full or denied one. */
const storage = (refuse = false) => {
  const items = new Map<string, string>();
  const fail = () => {
    if (refuse) throw new DOMException("No room", "QuotaExceededError");
  };
  return {
    items,
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => (fail(), items.get(key) ?? null),
    setItem: (key: string, value: string) => (fail(), void items.set(key, value)),
    removeItem: (key: string) => (fail(), void items.delete(key))
  } satisfies Storage & { items: Map<string, string> };
};

const who = { viewer: "usr_ada", company: "cmp_harbor" };
const list: SwitcherList = {
  viewer: { id: "usr_ada", companyId: "cmp_harbor", role: "member" },
  company: { handle: "harbor", name: "Harbor Works" },
  whatsNewUnseen: 2,
  patches: [
    {
      id: "p1",
      name: "site-notes",
      title: "Site notes",
      tier: 2,
      mine: true,
      openedAt: "2026-11-06T10:00:00.000Z",
      score: 1.5
    }
  ],
  shared: [
    {
      id: "p9",
      company: { handle: "pine", name: "Pine Studio" },
      name: "moodboard",
      title: "",
      tier: 1
    }
  ]
};

describe("the switcher's entry", () => {
  it("keeps one viewer's list and pointers, and reads them back", () => {
    const tab = storage();
    writeKept(tab, { ...who, list, savedAt: 5, current: "p1", previous: "p9" });
    expect(tab.items.size).toBe(1);
    expect(readKept(tab, who)).toEqual({ ...who, list, savedAt: 5, current: "p1", previous: "p9" });
  });

  it("holds row metadata only", () => {
    const tab = storage();
    writeKept(tab, { ...who, list, savedAt: 5, current: "p1" });
    const stored = JSON.parse(tab.items.get("patchy.switcher")!);
    expect(Object.keys(stored).sort()).toEqual([
      "company",
      "current",
      "list",
      "savedAt",
      "v",
      "viewer"
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/https?:|token|@/);
  });

  it("ignores another viewer's or another company's entry, and replaces it on write", () => {
    const tab = storage();
    writeKept(tab, { ...who, list, savedAt: 5, current: "p1" });
    expect(readKept(tab, { ...who, viewer: "usr_ben" })).toEqual({ ...who, viewer: "usr_ben" });
    expect(readKept(tab, { ...who, company: "cmp_pine" })).toEqual({ ...who, company: "cmp_pine" });
    writeKept(tab, { ...who, viewer: "usr_ben" });
    expect(readKept(tab, who)).toEqual(who);
  });

  it("drops a list that isn't one or isn't the viewer's, keeping the pointers", () => {
    const tab = storage();
    const write = (entry: object) =>
      tab.items.set("patchy.switcher", JSON.stringify({ v: 1, ...who, current: "p1", ...entry }));
    write({ list: { ...list, patches: [{ id: 3 }] }, savedAt: 5 });
    expect(readKept(tab, who)).toEqual({ ...who, current: "p1", previous: undefined });
    write({ list: { ...list, viewer: { ...list.viewer, id: "usr_ben" } }, savedAt: 5 });
    expect(readKept(tab, who).list).toBeUndefined();
    write({ list, savedAt: "yesterday" });
    expect(readKept(tab, who).list).toBeUndefined();
  });

  it("counts an older version, unreadable JSON or refusing storage as nothing kept", () => {
    const tab = storage();
    tab.items.set("patchy.switcher", JSON.stringify({ v: 0, ...who, current: "p1" }));
    expect(readKept(tab, who)).toEqual(who);
    tab.items.set("patchy.switcher", "{");
    expect(readKept(tab, who)).toEqual(who);
    const full = storage(true);
    expect(() => writeKept(full, { ...who, list, savedAt: 5 })).not.toThrow();
    expect(readKept(full, who)).toEqual(who);
    expect(() => forgetKept(full)).not.toThrow();
    expect(readKept(undefined, who)).toEqual(who);
  });

  it("forgets everything at once", () => {
    const tab = storage();
    writeKept(tab, { ...who, list, savedAt: 5, current: "p1", previous: "p9" });
    forgetKept(tab);
    expect(readKept(tab, who)).toEqual(who);
  });

  it("moves the tab's patch to previous only when another patch's shell opens", () => {
    const start = { ...who, current: "p1", previous: "p0" };
    expect(arrive(start, "p1")).toBe(start);
    expect(arrive(start, "p2")).toEqual({ ...who, current: "p2", previous: "p1" });
    expect(arrive(who, "p2")).toEqual({ ...who, current: "p2", previous: undefined });
  });
});
