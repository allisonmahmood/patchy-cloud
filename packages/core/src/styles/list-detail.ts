/**
 * `listDetail`: a list beside the entry it opens. The open entry's row is filled and marked at its
 * edge. Below 1024px each is a screen of its own, and the open entry's header leads back to the
 * list; on a wide page that link isn't needed, as the list is beside it.
 */
export const listDetail = `
    .list-detail { display: grid; grid-template-columns: 248px minmax(0, 1fr); gap: var(--space-6); align-items: start; }
    .list-detail-list .row { min-height: var(--h-row-2); }
    .list-detail-row:has(> .row-main a[aria-current]) { background: var(--selected); }
    .list-detail-row:has(> .row-main a[aria-current])::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--ink); }
    .list-detail-entry { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); min-width: 0; }
    .list-detail-head { display: grid; gap: var(--space-2); }
    .list-detail-head .title-sm { margin: 0; overflow-wrap: anywhere; }
    .list-detail-head > .ph-parent { display: none; }
    @media (max-width: 1023px) {
      .list-detail { grid-template-columns: minmax(0, 1fr); }
      .list-detail-at-list > .list-detail-entry, .list-detail-at-entry > .list-detail-list { display: none; }
      .list-detail-head > .ph-parent { display: inline-flex; }
      .page:has(> .list-detail-at-entry) > .ph { display: none; }
    }
`;
