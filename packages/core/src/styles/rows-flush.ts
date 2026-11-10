/**
 * Rows flush with what holds them, under a small label, as a dialog's list of people: no inset,
 * long words in a description wrap, and on a phone a row's end drops under its name.
 */
export const rowsFlush = `
    .rows-flush > .rows > .row { padding-inline: 0; }
    .rows-flush .row-desc { overflow-wrap: anywhere; }
    @media (max-width: 639px) {
      .rows-flush > .rows > .row { grid-template-columns: auto minmax(0, 1fr); }
      .rows-flush .row-end { grid-column: 2; justify-self: start; }
    }
`;
