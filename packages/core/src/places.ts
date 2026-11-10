/** Where Patchy's own pages are, for the sidebar and the switcher; it depends on nothing. */

/**
 * Settings: company management, one page each. The sidebar shows them under Settings while one
 * of them is open; the switcher lists them as places of their own.
 */
const settingsPlaces = [
  { href: "/settings/people", label: "People", section: "people" },
  { href: "/settings/integrations", label: "Integrations", section: "integrations" },
  { href: "/settings/agent-access", label: "Agent access", section: "agent-access" }
] as const;

/**
 * The sidebar's places, in order. Every role sees the same map: what a member can't change is
 * read-only on its page, never missing here. Settings is no page of its own: it opens People and
 * holds `settingsPlaces`.
 */
export const places = [
  { href: "/", label: "Home", section: "home" },
  { href: "/patches", label: "All patches", section: "patches" },
  { href: "/agents", label: "Your agents", section: "agents" },
  { href: "/settings/people", label: "Settings", section: "settings", children: settingsPlaces }
] as const;

/** A place a page can belong to: one with a page of its own, so every place but Settings. */
export type Place =
  | Exclude<(typeof places)[number], { readonly children: unknown }>
  | (typeof settingsPlaces)[number];

/** Every place with a page of its own, in the sidebar's order. */
export const pagePlaces: ReadonlyArray<Place> = places.flatMap((place): ReadonlyArray<Place> =>
  "children" in place ? place.children : [place]
);

/** What's new, reached from the sidebar's foot rather than its places. */
export const whatsNewPath = "/whats-new";
