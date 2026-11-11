/**
 * A row of fields: they share the line and wrap when it runs out. A field whose control has an
 * answer width keeps to it, and its hint or error wraps to the field's width rather than widening
 * it, so the row never runs past its column. Layout only.
 */
export const fieldRows = `
    .field-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-4); }
    .field-row > .fieldset { flex: 1 1 14rem; max-width: 100%; }
    .field-row > .fieldset:has(.field-w-xs, .field-w-sm, .field-w-md) { flex: 0 1 auto; }
    .field-row > .fieldset > :is(.field-hint, .field-error) { contain: inline-size; }
`;
