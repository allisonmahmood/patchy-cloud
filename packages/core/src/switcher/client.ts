/// <reference lib="dom" />
/**
 * The switcher's list in the browser: what the tab keeps (`cache.ts`), refreshed from
 * `/switcher.json` with the page's session. Any signed-in page can run one, a notice as well as
 * an app page or a patch's shell; the menu reads it and never waits on it.
 *
 * - It asks once as the page loads, and again when the menu opens if its copy is over a minute
 *   old or the last ask kept it.
 * - It adopts a list only for the viewer and company the page was rendered for. A refresh
 *   replaces the list, so a revoked grant, a retired patch or a shared patch made public drops
 *   out at once.
 * - A stale session that can be refreshed is, once, through `window.patchySession`, then asked
 *   again once. Unavailable, or refresh-required a second time, keeps the copy until next time.
 * - Signed out, refused, someone else's list or anything that isn't one forgets the entry, its
 *   pointers and memory, so the menu shows Patchy's places only. So does signing out on the page
 *   (`forgetOnSignOut`), before it leaves for a door that has no switcher.
 */
import { arrive, forgetKept, type Kept, readKept, type Who, writeKept } from "./cache.js";
import { type SwitcherList, switcherList } from "./list.js";

/** Refreshes the page's session: `window.patchySession.refresh` once the session's script runs. */
export type SessionRefresh = () => Promise<"refreshed" | "signed-out" | "unavailable">;

declare global {
  interface Window {
    // As Serving's stream declares it: the two must stay the same type.
    patchySession?: {
      refresh(): Promise<"refreshed" | "signed-out" | "unavailable">;
    };
  }
}

export interface SwitcherClient {
  /** What the menu can show now. */
  readonly kept: () => Kept;
  /** Asks again if the copy is over a minute old or the last ask kept it. */
  readonly freshen: () => void;
  /** Calls `listener` whenever the list is adopted or forgotten. */
  readonly onChange: (listener: () => void) => void;
  /**
   * Forgets the list, the pointers and the tab's entry for good, as when the person signs out: an
   * answer still on its way is dropped, and the client asks nothing more.
   */
  readonly forget: () => void;
}

/** How long a copy stays fresh enough not to ask again on open. */
export const FRESH_MS = 60_000;

type Answer = { readonly list: SwitcherList } | "refresh" | "keep" | "forget";

export const switcherClient = (options: {
  readonly who: Who;
  /** The patch this page's shell shows, which moves the tab's pointers. */
  readonly here?: string | undefined;
  readonly storage: Storage | undefined;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** The session's refresh once its script has run, or undefined when the page has none. */
  readonly session: () => Promise<SessionRefresh | undefined>;
}): SwitcherClient => {
  const { who, storage } = options;
  let kept = readKept(storage, who);
  if (options.here !== undefined) {
    kept = arrive(kept, options.here);
    writeKept(storage, kept);
  }
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let asking = false;
  let retry = false;
  let forgotten = false;

  const get = async (): Promise<Answer> => {
    const response = await options.fetch("/switcher.json", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      headers: { accept: "application/json" }
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const list = switcherList(body);
      return list !== undefined &&
        list.viewer.id === who.viewer &&
        list.viewer.companyId === who.company
        ? { list }
        : "forget";
    }
    const code =
      typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    if (response.status === 401 && code === "session_refresh_required") return "refresh";
    if (response.status === 503 && code === "unavailable") return "keep";
    // Signed out, refused, or a host that has no list.
    return "forget";
  };

  const ask = async () => {
    let answer: Answer;
    try {
      answer = await get();
      if (answer === "refresh") {
        const refresh = await options.session();
        const result = refresh === undefined ? "unavailable" : await refresh();
        answer = result === "signed-out" ? "forget" : result === "refreshed" ? await get() : "keep";
        if (answer === "refresh") answer = "keep";
      }
    } catch {
      // Offline, or the request failed on the way: like unavailable.
      answer = "keep";
    }
    // Signed out while it was on its way: what it brought is no longer anyone's.
    if (forgotten) return;
    retry = answer === "keep";
    if (answer === "keep") return;
    if (answer === "forget") {
      forgetKept(storage);
      kept = who;
    } else {
      kept = { ...kept, list: answer.list, savedAt: options.now() };
      writeKept(storage, kept);
    }
    changed();
  };

  const askNow = () => {
    if (asking || forgotten) return;
    asking = true;
    void ask().finally(() => {
      asking = false;
    });
  };
  askNow();

  return {
    kept: () => kept,
    freshen: () => {
      if (retry || kept.savedAt === undefined || options.now() - kept.savedAt > FRESH_MS) askNow();
    },
    onChange: (listener) => {
      listeners.add(listener);
    },
    forget: () => {
      if (forgotten) return;
      forgotten = true;
      forgetKept(storage);
      kept = who;
      changed();
    }
  };
};

/**
 * Forgets `client`'s list as soon as the page posts a sign-out form, before the browser leaves for
 * the sign-in door, which loads no switcher to forget it there.
 */
export const forgetOnSignOut = (client: SwitcherClient, page: Document) =>
  page.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && new URL(form.action).pathname === "/logout")
        client.forget();
    },
    true
  );

/**
 * The page's session refresh, once the session's script has run: it loads after the switcher's,
 * so this waits for the document's deferred scripts. A page without one, such as a dev persona's,
 * gets undefined.
 */
export const pageSession = (): Promise<SessionRefresh | undefined> =>
  new Promise((resolve) => {
    const found = () => {
      const session = window.patchySession;
      resolve(session === undefined ? undefined : () => session.refresh());
    };
    if (window.patchySession !== undefined || document.readyState === "complete") return found();
    // Deferred scripts run before DOMContentLoaded; load is the backstop for a late start.
    document.addEventListener("DOMContentLoaded", found, { once: true });
    window.addEventListener("load", found, { once: true });
  });
