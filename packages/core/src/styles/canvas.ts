/**
 * The canvas: Patchy's squared paper, 32px squares over a blue → cream → green wash, behind every
 * door and app page alike, so sign-in and the app are one surface. It scrolls with the page, never
 * fixed to the window, so nothing repaints as the page moves. Only what is bordered, pressed or
 * floats has a surface of its own: the sidebar and top bar, the door card, boxes, cards, tiles,
 * notices, controls, menus and dialogs. Everything else, such as tables, lists, prose, a flow's
 * sections and the page's titles, has none, so the squares show behind it, and a row's hover is a
 * translucent tint over them.
 */
export const canvas = `
    body:has(.auth-card, .app) {
      background:
        linear-gradient(var(--canvas-grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--canvas-grid) 1px, transparent 1px),
        linear-gradient(180deg, var(--info-bg) 0%, var(--paper) 40%, var(--success-bg) 100%);
      background-size: 32px 32px, 32px 32px, auto;
    }
`;
