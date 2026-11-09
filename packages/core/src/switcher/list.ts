/**
 * The switcher list, as `/switcher.json` answers a signed-in person's browser (Portal's
 * `SwitcherList`), and the check the switcher holds a response or a stored copy to before using
 * it. The check is by hand, so the switcher's script carries no schema library.
 */

/** What `/switcher.json` answers a signed-in person. Titles are as published, possibly blank. */
export interface SwitcherList {
  readonly viewer: {
    readonly id: string;
    readonly companyId: string;
    readonly role: "member" | "admin" | "super_admin";
  };
  readonly company: { readonly handle: string; readonly name: string };
  /** How many What's new changes shipped since the viewer last looked. */
  readonly whatsNewUnseen: number;
  /** The company's live patches the viewer can open, its public ones included. */
  readonly patches: ReadonlyArray<SwitcherPatch>;
  /** Other companies' patches shared with the viewer that they can open now and aren't public. */
  readonly shared: ReadonlyArray<SwitcherShared>;
}

export interface SwitcherPatch {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly tier: number;
  /** The viewer owns it. */
  readonly mine: boolean;
  /** When the viewer last opened it; absent until they do. */
  readonly openedAt?: string;
  /** The viewer's halving open score, as Home's Your usual ranks by; absent with `openedAt`. */
  readonly score?: number;
}

export interface SwitcherShared {
  readonly id: string;
  readonly company: { readonly handle: string; readonly name: string };
  readonly name: string;
  readonly title: string;
  readonly tier: number;
}

type Fields = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const company = (value: unknown): value is SwitcherShared["company"] =>
  record(value) && text(value.handle) && text(value.name);
const patch = (value: unknown): value is SwitcherPatch =>
  record(value) &&
  text(value.id) &&
  text(value.name) &&
  text(value.title) &&
  count(value.tier) &&
  typeof value.mine === "boolean" &&
  (value.openedAt === undefined ||
    (text(value.openedAt) && Number.isFinite(Date.parse(value.openedAt)))) &&
  (value.score === undefined || count(value.score));
const shared = (value: unknown): value is SwitcherShared =>
  record(value) &&
  text(value.id) &&
  company(value.company) &&
  text(value.name) &&
  text(value.title) &&
  count(value.tier);

/**
 * `value` as a switcher list, keeping only the fields the switcher reads, or undefined when it
 * isn't one.
 */
export const switcherList = (value: unknown): SwitcherList | undefined => {
  if (!record(value) || !record(value.viewer) || !company(value.company)) return undefined;
  const { viewer } = value;
  if (
    !text(viewer.id) ||
    !text(viewer.companyId) ||
    (viewer.role !== "member" && viewer.role !== "admin" && viewer.role !== "super_admin") ||
    !count(value.whatsNewUnseen) ||
    !Array.isArray(value.patches) ||
    !value.patches.every(patch) ||
    !Array.isArray(value.shared) ||
    !value.shared.every(shared)
  )
    return undefined;
  return {
    viewer: { id: viewer.id, companyId: viewer.companyId, role: viewer.role },
    company: { handle: value.company.handle, name: value.company.name },
    whatsNewUnseen: value.whatsNewUnseen,
    patches: value.patches.map(({ id, name, title, tier, mine, openedAt, score }) => ({
      id,
      name,
      title,
      tier,
      mine,
      ...(openedAt === undefined ? {} : { openedAt }),
      ...(score === undefined ? {} : { score })
    })),
    shared: value.shared.map(({ id, company, name, title, tier }) => ({
      id,
      company: { handle: company.handle, name: company.name },
      name,
      title,
      tier
    }))
  };
};
