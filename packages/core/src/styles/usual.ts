/**
 * Home's Your usual: up to four tiles in a row, two below 1024px. A tile rests flat on a hairline
 * and lifts only on hover with a fine pointer. On a phone it keeps the name and drops the meta.
 */
export const usual = `
    .usual { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .usual > li { min-width: 0; }
    .usual-tile {
      display: flex; align-items: center; gap: var(--space-3); height: 100%; min-width: 0;
      padding: var(--space-3) 14px;
      border: 1px solid var(--border); border-radius: var(--r-container);
      background: var(--surface); color: var(--text); font-weight: var(--weight-regular); text-decoration: none;
      transition: transform .12s, box-shadow .12s, border-color .12s;
    }
    @media (hover: hover) { .usual-tile:hover { border-color: var(--ink); box-shadow: var(--lift-tile); transform: translate(-2px, -2px); } }
    .usual-tile .row-name, .usual-tile .row-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 1023px) { .usual { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 639px) {
      .usual { gap: var(--space-2); }
      .usual-tile { padding: 10px; }
      .usual-tile .row-name { white-space: normal; }
      .usual-tile .row-desc { display: none; }
    }
`;
