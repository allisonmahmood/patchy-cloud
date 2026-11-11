import type { Icon } from "./rows.js";

/** The icons the switcher's rows wear for Patchy's places and a patch's card pages. */
const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons: Readonly<Record<Icon, string>> = {
  home: icon('<path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"/>'),
  patches: icon(
    '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'
  ),
  agents: icon(
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/>'
  ),
  people: icon(
    '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.8c1.7.6 2.7 2.2 3 4.7"/>'
  ),
  integrations: icon(
    '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>'
  ),
  "agent-access": icon(
    '<path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.5 7 9 4.1-1.5 7-4.7 7-9V6.2z"/><path d="m9 12 2.2 2.2L15.5 10"/>'
  ),
  "whats-new": icon(
    '<path d="M12 3.5c.7 4.4 1.9 6.6 7.5 8.5-5.6 1.9-6.8 4.1-7.5 8.5-.7-4.4-1.9-6.6-7.5-8.5 5.6-1.9 6.8-4.1 7.5-8.5z"/>'
  ),
  overview: icon(
    '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 12.5h8M8 16h5"/>'
  ),
  versions: icon(
    '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5" opacity=".55"/>'
  ),
  log: icon(
    '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'
  ),
  settings: icon(
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>'
  )
};
