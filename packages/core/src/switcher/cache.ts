/**
 * What the switcher keeps for a tab: one versioned `sessionStorage` entry holding the last list
 * adopted for one viewer at one company, and the patch the tab showed last and the one before,
 * for the flip back. It holds only row metadata, never tokens, people, what was typed or URLs.
 *
 * An entry for anyone else, an older version, or one that doesn't read back counts as none, and
 * so does storage the browser denies or has no room in: the switcher then works from memory.
 */
import { type SwitcherList, switcherList } from "./list.js";

/** Whose entry this is: the viewer and company the server rendered into the page. */
export interface Who {
  readonly viewer: string;
  readonly company: string;
}

export interface Kept extends Who {
  /** The last list adopted for them, and when, in epoch milliseconds. */
  readonly list?: SwitcherList | undefined;
  readonly savedAt?: number | undefined;
  /** The patch this tab's last company shell showed, and the one before it, by id. */
  readonly current?: string | undefined;
  readonly previous?: string | undefined;
}

const key = "patchy.switcher";
const version = 1;

/** The tab's storage, or undefined where reaching it throws. */
export const tabStorage = (): Storage | undefined => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

/** What the tab keeps for `who`; with nothing usable stored, just `who`. */
export const readKept = (storage: Storage | undefined, who: Who): Kept => {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) return who;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return who;
    const entry = stored as Readonly<Record<string, unknown>>;
    if (entry.v !== version || entry.viewer !== who.viewer || entry.company !== who.company)
      return who;
    const list = switcherList(entry.list);
    const adopted =
      list !== undefined &&
      list.viewer.id === who.viewer &&
      list.viewer.companyId === who.company &&
      typeof entry.savedAt === "number";
    const id = (value: unknown) => (typeof value === "string" ? value : undefined);
    return {
      ...who,
      ...(adopted ? { list, savedAt: entry.savedAt as number } : {}),
      current: id(entry.current),
      previous: id(entry.previous)
    };
  } catch {
    return who;
  }
};

/** Keeps `kept` for the tab, replacing anyone else's entry; a refusal keeps nothing. */
export const writeKept = (storage: Storage | undefined, kept: Kept) => {
  try {
    storage?.setItem(
      key,
      JSON.stringify({
        v: version,
        viewer: kept.viewer,
        company: kept.company,
        list: kept.list,
        savedAt: kept.savedAt,
        current: kept.current,
        previous: kept.previous
      })
    );
  } catch {
    // Full or denied: the switcher works from memory.
  }
};

/** Forgets the tab's entry, list and pointers alike. */
export const forgetKept = (storage: Storage | undefined) => {
  try {
    storage?.removeItem(key);
  } catch {
    // Denied storage holds nothing to forget.
  }
};

/**
 * The tab opened a company shell for `patch`: a different patch moves the current one to
 * previous, while a reload or a route change in the same patch leaves both alone.
 */
export const arrive = (kept: Kept, patch: string): Kept =>
  kept.current === patch ? kept : { ...kept, current: patch, previous: kept.current };
