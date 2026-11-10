/** Where Patchy's own pages are, for the sidebar and the switcher; it depends on nothing. */

/**
 * The sidebar's places, in order. Every role sees the same map: what a member can't change is
 * read-only on its page, never missing here. The second group's label names the scope its places
 * share; the company's name rides on the brand above.
 */
export const places = [
  {
    label: undefined,
    items: [
      { href: "/", label: "Home", section: "home" },
      { href: "/patches", label: "All patches", section: "patches" },
      { href: "/agents", label: "Your agents", section: "agents" }
    ]
  },
  {
    label: "Company",
    items: [
      { href: "/settings/people", label: "People", section: "people" },
      { href: "/settings/integrations", label: "Integrations", section: "integrations" },
      { href: "/settings/agent-access", label: "Agent access", section: "agent-access" }
    ]
  }
] as const;

/** What's new, reached from the sidebar's foot rather than its places. */
export const whatsNewPath = "/whats-new";
