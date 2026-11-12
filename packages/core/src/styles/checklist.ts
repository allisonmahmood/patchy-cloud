/**
 * `checklist`: checkbox rows in a box. A press anywhere on a row toggles its box; a box that
 * can't be chosen keeps its row but mutes it. A box with a saved state shows Adding or Removing
 * while it differs from it.
 */
export const checklist = `
    .checklist { overflow: hidden; }
    .checkrow { cursor: pointer; }
    @media (hover: hover) { .checkrow:has(> input:enabled):hover { background: var(--hover); } }
    .checkrow:has(> input:disabled) { cursor: not-allowed; }
    .checkrow:has(> input:disabled) .row-name, .checkrow-muted .row-name { color: var(--muted); }
    .checkrow-adding, .checkrow-removing { display: none; margin-left: var(--space-2); }
    .checkrow:has(> input[data-saved="0"]:checked) .checkrow-adding,
    .checkrow:has(> input[data-saved="1"]:not(:checked)) .checkrow-removing { display: inline-flex; }
`;
