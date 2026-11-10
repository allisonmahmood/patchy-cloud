/**
 * Fields that belong side by side, such as a server and its port, or a region and a project: one
 * row that wraps onto separate lines when the space runs out, as on a phone. A field whose control
 * has an answer width keeps it; the rest share what's left. Items are `field` output.
 */
export const fieldRow = (fields: ReadonlyArray<string>) =>
  `<div class="field-row">${fields.join("")}</div>`;
