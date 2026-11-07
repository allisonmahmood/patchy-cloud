import { describe, expect, it, vi } from "vitest";
import { readKept, writeKept } from "./cache.js";
import { FRESH_MS, type SessionRefresh, switcherClient } from "./client.js";
import type { SwitcherList } from "./list.js";

const who = { viewer: "usr_ada", company: "cmp_harbor" };
const list = (title = "Site notes"): SwitcherList => ({
  viewer: { id: "usr_ada", companyId: "cmp_harbor", role: "member" },
  company: { handle: "harbor", name: "Harbor Works" },
  whatsNewUnseen: 0,
  patches: [{ id: "p1", name: "site-notes", title, tier: 2, mine: true }],
  shared: []
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string) => json(status, { ok: false, code, error: code });

/** A tab's storage in memory. */
const tab = () => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  } satisfies Storage;
};

/** A client whose fetch answers from `answers` in turn, a moment after it first asks. */
const start = async (
  answers: Array<() => Response>,
  options: {
    storage?: Storage;
    here?: string;
    refresh?: SessionRefresh;
    clock?: { now: number };
  } = {}
) => {
  const storage = options.storage ?? tab();
  const clock = options.clock ?? { now: 1_000 };
  const fetch = vi.fn(() => {
    const answer = answers.shift();
    return answer ? Promise.resolve(answer()) : Promise.reject(new TypeError("offline"));
  });
  const changes = vi.fn();
  const client = switcherClient({
    who,
    here: options.here,
    storage,
    fetch,
    now: () => clock.now,
    session: () => Promise.resolve(options.refresh)
  });
  client.onChange(changes);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { client, fetch, changes, storage, clock };
};

describe("the switcher's client", () => {
  it("asks as the page loads, adopts the viewer's list and keeps it for the tab", async () => {
    const { client, fetch, storage } = await start([() => json(200, list())]);
    expect(fetch).toHaveBeenCalledWith(
      "/switcher.json",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" })
    );
    expect(client.kept().list).toEqual(list());
    expect(readKept(storage, who).list).toEqual(list());
  });

  it("asks again on open only once its copy is over a minute old", async () => {
    const { client, fetch, clock } = await start([
      () => json(200, list()),
      () => json(200, list("Site notes v2"))
    ]);
    client.freshen();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now += FRESH_MS + 1;
    client.freshen();
    await vi.waitFor(() => expect(client.kept().list?.patches[0]?.title).toBe("Site notes v2"));
  });

  it("refreshes a stale session once and asks again", async () => {
    const refresh = vi.fn<SessionRefresh>(() => Promise.resolve("refreshed"));
    const { client } = await start(
      [() => refusal(401, "session_refresh_required"), () => json(200, list())],
      { refresh }
    );
    await vi.waitFor(() => expect(client.kept().list).toEqual(list()));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the copy when the session is still stale after its refresh, and tries again on open", async () => {
    const storage = tab();
    writeKept(storage, { ...who, list: list(), savedAt: 1_000 });
    const refresh = vi.fn<SessionRefresh>(() => Promise.resolve("refreshed"));
    const { client, fetch, changes } = await start(
      [
        () => refusal(401, "session_refresh_required"),
        () => refusal(401, "session_refresh_required"),
        () => json(200, list("Back"))
      ],
      { storage, refresh }
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(client.kept().list).toEqual(list());
    expect(changes).not.toHaveBeenCalled();
    client.freshen();
    await vi.waitFor(() => expect(client.kept().list?.patches[0]?.title).toBe("Back"));
  });

  it.each([
    ["unavailable", () => refusal(503, "unavailable")],
    ["offline", () => Promise.reject(new TypeError("offline")) as never]
  ])("keeps the copy when the list is %s", async (_, answer) => {
    const storage = tab();
    writeKept(storage, { ...who, list: list(), savedAt: 1_000, current: "p1" });
    const { client } = await start([answer], { storage });
    expect(client.kept()).toMatchObject({ list: list(), current: "p1" });
  });

  it.each([
    ["signed out", [() => refusal(401, "session_expired")], undefined],
    ["refused", [() => refusal(403, "access_denied")], undefined],
    [
      "another viewer's",
      [() => json(200, { ...list(), viewer: { ...list().viewer, id: "usr_ben" } })],
      undefined
    ],
    ["not a list", [() => new Response("<!doctype html>", { status: 404 })], undefined],
    [
      "signed out on refresh",
      [() => refusal(401, "session_refresh_required")],
      () => Promise.resolve("signed-out" as const)
    ]
  ])("forgets the list, the pointers and the entry when it is %s", async (_, answers, refresh) => {
    const storage = tab();
    writeKept(storage, { ...who, list: list(), savedAt: 1_000, current: "p1", previous: "p0" });
    const { client, changes } = await start(answers, { storage, refresh });
    await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    expect(client.kept()).toEqual(who);
    expect(storage.getItem("patchy.switcher")).toBeNull();
  });

  it("keeps the copy when the page has no session to refresh", async () => {
    const storage = tab();
    writeKept(storage, { ...who, list: list(), savedAt: 1_000 });
    const { client } = await start([() => refusal(401, "session_refresh_required")], { storage });
    expect(client.kept().list).toEqual(list());
  });

  it("forgets for good on sign-out, even with an answer still on its way", async () => {
    const storage = tab();
    writeKept(storage, { ...who, list: list(), savedAt: 1_000, current: "p1", previous: "p0" });
    const answer = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => answer.promise);
    const client = switcherClient({
      who,
      storage,
      fetch,
      now: () => 1_000,
      session: () => Promise.resolve(undefined)
    });
    const changes = vi.fn();
    client.onChange(changes);
    client.forget();
    expect(client.kept()).toEqual(who);
    expect(storage.getItem("patchy.switcher")).toBeNull();
    expect(changes).toHaveBeenCalledTimes(1);
    answer.resolve(json(200, list("Back from the dead")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.kept()).toEqual(who);
    expect(storage.getItem("patchy.switcher")).toBeNull();
    client.freshen();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("moves the tab's pointers when a company shell for another patch starts", async () => {
    const storage = tab();
    writeKept(storage, { ...who, current: "p0" });
    const { client } = await start([() => json(200, list())], { storage, here: "p1" });
    expect(client.kept()).toMatchObject({ current: "p1", previous: "p0" });
    expect(readKept(storage, who)).toMatchObject({ current: "p1", previous: "p0" });
  });
});
