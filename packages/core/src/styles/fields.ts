/**
 * The field family on native controls: label, hint, control, error, in that order. Inputs have
 * 1px ink edges at button height; a prefix is fused into its field; checkboxes and radios are the
 * browser's own in ink. The ring sits on the field, or on the group around a prefixed input.
 */
export const fields = `
    .fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
    .fieldset { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; margin: 0; padding: 0; border: 0; }
    .fieldset > legend { padding: 0; }
    .field-label { display: block; margin: var(--space-5) 0 6px; color: var(--ink); font: var(--text-label); }
    .fieldset > .field-label { margin: 0; }
    .field-optional { color: var(--muted); font-weight: var(--weight-regular); }
    .field-hint { margin: 6px 0 0; color: var(--muted); font: var(--text-meta); }
    .fieldset > .field-hint { margin: 0; }
    .field-error { margin: 6px 0 0; color: var(--danger); font: var(--text-meta); font-weight: var(--weight-medium); }
    .fieldset > .field-error { margin: 0; }

    .field {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: var(--h-control);
      margin: 0;
      padding: 0 var(--space-3);
      border: 1px solid var(--ink);
      border-radius: var(--r-control);
      background: var(--surface);
      color: var(--ink);
      font: var(--text-body);
      font-size: var(--field-text);
    }
    .field::placeholder, .field-group > input::placeholder { color: var(--placeholder); opacity: 1; }
    .field:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; box-shadow: inset 0 0 0 1px var(--ink); }
    .field[aria-invalid="true"] { border-color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }
    textarea.field { min-height: var(--h-textarea); padding-block: var(--space-2); resize: vertical; }
    /* field-grow: a textarea that starts one line tall and grows with what is typed or pasted. */
    textarea.field-grow { min-height: var(--h-control); max-height: 12rem; }
    @supports (field-sizing: content) { textarea.field-grow { field-sizing: content; resize: none; } }
    select.field { padding-right: var(--space-2); }
    .field-mono, .field-group > input.field-mono { font-family: var(--font-mono); font-size: var(--field-text-mono); }
    .field-w-xs { width: 12ch; }
    .field-w-sm { width: 18ch; }
    .field-w-md { width: 30ch; }

    /* field-group: a fixed prefix, such as the address a handle opens, fused before the input. The
       prefix is a second label, so pressing it focuses the input; a long prefix wraps. */
    .field-group { display: flex; align-items: stretch; padding: 0; overflow: hidden; cursor: text; }
    .field-group > input { flex: 1; min-width: 8ch; min-height: calc(var(--h-control) - 2px); padding: 0 var(--space-3); border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--field-text); }
    .field-group > input:focus-visible { outline: none; }
    .field-group:has(> input:focus-visible) { outline: 2px solid var(--ink); outline-offset: 2px; box-shadow: inset 0 0 0 1px var(--ink); }
    .field-group:has(> [aria-invalid="true"]) { border-color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }
    .field-prefix {
      display: flex; flex: 0 1 auto; align-items: center; align-self: stretch; min-width: 0;
      padding: 6px 10px; border-right: 1px solid var(--border);
      background: var(--sunken); color: var(--muted);
      font: var(--text-code); overflow-wrap: anywhere; cursor: text;
    }
    /* field-search: searchField's group, whose prefix is the search icon. */
    .field-search > .field-prefix { padding: 0 0 0 10px; border-right: 0; background: transparent; }
    .field-search > input { padding-left: var(--space-2); }
    .field-group:has(> input:disabled) { opacity: .55; cursor: not-allowed; }

    .field-choice, .choice { display: flex; align-items: center; gap: 10px; min-height: var(--h-sm); padding: var(--space-1) 0; color: var(--ink); cursor: pointer; }
    .choice-row { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); }
    .field-checkbox, .field-radio { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--ink); cursor: pointer; }
    .field:disabled, .field-checkbox:disabled, .field-radio:disabled { opacity: .55; cursor: not-allowed; }

    /* secret: a password field whose Show button the enhancer reveals; without script it stays hidden. */
    .secret { position: relative; display: flex; align-items: center; }
    .secret > .field { padding-right: 72px; font-family: var(--font-mono); }
    .secret > .btn { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); }
    .secret > .btn:active { transform: translateY(-50%); }
    .secret > [hidden] { display: none; }

    /* switch: a one-button form in a setting row, its state in aria-checked. */
    .switch {
      position: relative; display: inline-flex; align-items: center; flex: none;
      width: 40px; height: 24px; margin: 0; padding: 2px;
      border: 1.5px solid var(--ink); border-radius: var(--r-round);
      background: var(--sunken); cursor: pointer;
    }
    .switch::after { content: ""; width: 17px; height: 17px; border: 1.5px solid var(--ink); border-radius: 50%; background: var(--surface); }
    .switch[aria-checked="true"] { background: var(--ink); }
    .switch[aria-checked="true"]::after { margin-left: auto; border-color: var(--yellow); background: var(--yellow); }
    @media (pointer: coarse) { .switch::before { content: ""; position: absolute; inset: -10px; } }

    /* copy-line: one line to hand to an agent, selectable whole. Its Copy button starts hidden and
       the page's copy script reveals it, so without script the line is still there to select. */
    .copy-line {
      display: flex; align-items: center; gap: var(--space-3);
      min-height: var(--h-row); padding: 6px 6px 6px 14px;
      border: 1px solid var(--ink); border-radius: var(--r-control);
      background: var(--surface);
    }
    .copy-line > code { flex: 1; min-width: 0; padding: 0; background: none; color: var(--ink); font: var(--text-code); user-select: all; overflow-wrap: anywhere; }
    .copy-line > .btn { flex: none; }
    .copy-line > [hidden] { display: none; }
    @media (max-width: 479px) {
      .copy-line { flex-wrap: wrap; padding: 10px var(--space-3); }
      .copy-line > code { flex-basis: 100%; }
    }
`;
