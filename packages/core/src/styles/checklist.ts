/**
 * `checklist`: checkbox rows in a box. A press anywhere on a row toggles its box; a box that
 * can't be chosen keeps its row but mutes it.
 */
export const checklist = `
    .checklist { overflow: hidden; }
    .checkrow { cursor: pointer; }
    @media (hover: hover) { .checkrow:has(> input:enabled):hover { background: var(--hover); } }
    .checkrow:has(> input:disabled) { cursor: not-allowed; }
    .checkrow:has(> input:disabled) .row-name { color: var(--muted); }
`;
