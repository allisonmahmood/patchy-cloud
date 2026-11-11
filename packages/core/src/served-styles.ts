/**
 * A running patch's shell styles: what the shell draws over its frame (page-state notices, the
 * starting cover, downloads, the switcher) and the tokens those need. `serving/src/shell.ts` puts
 * them in every patch's shell, so they change only on purpose, never with an app restyle: a test
 * pins their bytes. First-party pages use `appStyles` in `html.ts` instead.
 */
export const servedStyles = `
    :root {
      --paper: #fffdf4;
      --paper-blue: #eaf5ff;
      --paper-green: #eff9e8;
      --paper-amber: #fff7e4;
      /* Mark tints: stronger than the papers, so a patch's mark reads at a glance beside its name. */
      --tint-green: #cdeebb;
      --tint-blue: #cfe4ff;
      --tint-amber: #ffe2a8;
      --tint-pink: #f6d3e4;
      --white: #fffefa;
      --ink: #12110f;
      --ink-soft: #36332d;
      --muted: #69645a;
      --line: rgba(18, 17, 15, .14);
      --line-strong: rgba(18, 17, 15, .30);
      --blue: #1263e6;
      --blue-dark: #093b92;
      --green: #64c83f;
      --green-ink: #2f6a17;
      --yellow: #ffbf35;
      --amber-ink: #8a5a00;
      --danger: #963c22;
      --field-radius: 6px;
      --shadow-hard: 4px 4px 0 var(--ink);
      --shadow-soft: 0 18px 50px rgba(18, 17, 15, .08);
      --radius: 8px;
      --radius-pill: 999px;
      --font-sans: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
      --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }
    :focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 3px;
      border-radius: 6px;
    }
    .glyph {
      position: relative;
      width: 30px;
      height: 30px;
      flex: none;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--green);
      box-shadow: 3px 3px 0 var(--ink);
      transform: rotate(-5deg);
    }

    .glyph::after {
      content: "";
      position: absolute;
      top: 6px;
      right: 5px;
      width: 10px;
      height: 10px;
      border-top: 2px solid var(--ink);
      border-right: 2px solid var(--ink);
    }
    .note {
      margin: 1.25rem 0;
      padding: 14px 16px 14px 18px;
      border: 1.5px solid var(--line-strong);
      border-left-width: 6px;
      border-radius: var(--radius);
      background: var(--white);
    }

    .note-title {
      display: block;
      margin-bottom: .25rem;
      color: var(--ink);
      font-weight: 800;
    }

    .note-warn {
      border-left-color: var(--yellow);
      background: var(--paper-amber);
    }

    .note-refused { border-left-color: var(--danger); background: var(--paper-amber); }
    .note-ok { border-left-color: var(--green-ink); background: var(--paper-green); }
    .supporting-text { color: var(--muted); font-size: .9rem; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 8px 14px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      color: var(--ink);
      font: inherit;
      font-size: .9rem;
      font-weight: 750;
      line-height: 1.3;
      text-decoration: none;
      cursor: pointer;
    }
    .btn-primary { background: var(--blue); color: var(--white); }
    .btn-quiet { border-color: transparent; background: transparent; text-decoration: underline; }
    .btn-danger { background: var(--paper-amber); color: var(--danger); }
    .btn:hover:not(:disabled) { box-shadow: 2px 2px 0 var(--ink); }
    /* A quiet button has no frame to lift, so it hovers with a light blue tint, translucent so it still shows on tinted notes. */
    .btn-quiet:hover:not(:disabled) { box-shadow: none; background: color-mix(in srgb, var(--blue) 10%, transparent); }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    code {
      padding: .12em .4em;
      border-radius: 5px;
      background: rgba(18, 17, 15, .06);
      font-family: var(--font-mono);
      font-size: .9em;
    }
    /* glyph-sm: the Patchy glyph at a floating element's title size, so the viewer knows Patchy is speaking. Use with glyph. */
    .glyph-sm { width: 18px; height: 18px; border-radius: 5px; box-shadow: 2px 2px 0 var(--ink); }
    .glyph-sm::after { top: 3px; right: 3px; width: 5px; height: 5px; }
    /* note-float: a note floating over the served frame; the ink border and hard shadow mark it first-party. */
    .note-float {
      margin: 0;
      padding: 12px 14px;
      border-width: 2px 2px 2px 6px;
      border-top-color: var(--ink);
      border-right-color: var(--ink);
      border-bottom-color: var(--ink);
      box-shadow: var(--shadow-hard);
      font-size: .9rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .note-float .note-title { display: flex; align-items: center; gap: 8px; }
    /* A tag in a floating note's title, such as a setting's On or Off, keeps its word whole at the end. */
    .note-float .note-title > .tag { flex: none; margin-left: auto; }
    .note-float p { margin: 0; }
    .note-float p + p { margin-top: 6px; }
    /* note-info: Patchy offers something, such as a new version. */
    .note-info { border-left-color: var(--blue); background: var(--paper-blue); }
    /* status-chip: one line over the frame. Passive (reconnecting) it has no action; a folded note keeps one action and its paper. */
    .status-chip {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      max-width: 100%;
      min-height: 36px;
      padding: 5px 14px 5px 8px;
      border: 2px solid var(--ink);
      border-radius: var(--radius-pill);
      background: var(--white);
      box-shadow: var(--shadow-hard);
      color: var(--ink);
      font-size: .85rem;
      font-weight: 750;
      line-height: 1.2;
    }
    .status-chip-detail { color: var(--muted); font-weight: 500; }
    .status-chip:has(.btn) { padding: 3px 3px 3px 10px; border-radius: var(--radius); }
    .status-chip .btn { margin-left: 6px; }
    .status-chip-warn { background: var(--paper-amber); }
    .status-chip-info { background: var(--paper-blue); }
    /* note-collapse: the quiet Hide that folds a note-float into a status-chip without dismissing it. Negative margins keep the
       44px target without growing the row; in a note-inline bar it takes the top-right cell, level with the title. */
    .note-float .note-collapse { flex: none; margin: -12px -10px -12px auto; padding-inline: 10px; white-space: nowrap; }
    .note-inline > .note-collapse { grid-area: 1 / -2; align-self: start; }
    /* shell-bottom: bottom-centre stack for the served page's state. It grows upward, so the bar at the edge stays put. */
    .shell-bottom {
      position: fixed;
      right: 16px;
      bottom: 16px;
      left: 16px;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      pointer-events: none;
      color: var(--ink-soft);
      font-family: var(--font-sans);
    }
    .shell-bottom, .shell-bottom * { box-sizing: border-box; }
    .shell-bottom > * { pointer-events: auto; }
    .shell-bottom [hidden] { display: none; }
    /* shell-corner: D-1 downloads, bottom right, apart from the bottom-centre page state. Newest card on top; the stack grows
       upward, so cards already up stay put. The end padding keeps the hard shadow inside the scroll box. */
    .shell-corner {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 3;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
      width: min(340px, calc(100% - 32px));
      max-height: calc(100dvh - 32px);
      overflow-y: auto;
      padding: 0 4px 4px 0;
      color: var(--ink-soft);
      font-family: var(--font-sans);
    }
    .shell-corner, .shell-corner * { box-sizing: border-box; }
    .shell-corner [hidden], .shell-corner[hidden] { display: none; }
    .shell-downloads { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .shell-corner .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .shell-corner details { width: 100%; }
    .shell-corner details > .shell-downloads { margin-top: 10px; }
    /* "N more files": older cards fold into a status-chip; a static chevron flips when open. */
    .shell-corner summary { display: flex; width: fit-content; min-height: 44px; margin-left: auto; cursor: pointer; list-style: none; }
    .shell-corner summary::-webkit-details-marker { display: none; }
    .shell-corner summary::after {
      content: "";
      width: 6px;
      height: 6px;
      margin: -3px 2px 0 4px;
      border-right: 2px solid var(--ink);
      border-bottom: 2px solid var(--ink);
      transform: rotate(45deg);
    }
    .shell-corner details[open] > summary::after { margin-top: 3px; transform: rotate(-135deg); }
    /* The 481-1364px band: a 620px page-state bar centred at the bottom can reach the corner, so while page state is up
       the downloads stack above it. --patchy-status-offset is the top of the page state, measured by the shell. */
    @media (min-width: 481px) and (max-width: 1364px) {
      body:has(.shell-bottom > :not([hidden])) .shell-corner {
        bottom: calc(var(--patchy-status-offset, 0px) + 10px);
        max-height: calc(100dvh - 26px - var(--patchy-status-offset, 0px));
      }
    }
    /* shell-scrim: the T-1 cover. A static dim over the whole frame with one centred note-float; nothing moves or fades.
       It is a modal dialog, so the dim is the dialog itself and the top-layer backdrop stays clear. */
    .shell-scrim {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      max-width: none;
      max-height: none;
      margin: 0;
      padding: 16px;
      border: 0;
      background: rgba(18, 17, 15, .38);
      color: var(--ink-soft);
      font-family: var(--font-sans);
    }
    .shell-scrim[open] { display: grid; place-items: center; }
    .shell-scrim, .shell-scrim * { box-sizing: border-box; }
    .shell-scrim::backdrop { background: transparent; }
    .shell-scrim [hidden] { display: none; }
    .shell-scrim > .note-float { width: min(420px, 100%); }
    /* The elapsed line follows the note's live region rather than a p, so it takes the note's paragraph gap here. */
    .shell-scrim .supporting-text { margin-top: 6px; }
    .shell-scrim .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .shell-scrim .actions:has(> [hidden]) { display: none; }
    /* Marks, labels and the field, shared by app pages and the served shell, where the switcher draws them. */
    /* mono: a tool's two-letter mark, tinted from its name and turned like the glyph; mono-blue, mono-green and
       mono-amber vary the tint. page-mark: a page's ruled sheet in the same footprint. */
    .mono { display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--yellow); color: var(--ink); font-size: .72rem; font-weight: 900; letter-spacing: .02em; line-height: 1; transform: rotate(-3deg); }
    .mono-blue { background: var(--tint-blue); }
    .mono-green { background: var(--tint-green); }
    .mono-amber { background: var(--tint-amber); }
    .mono-pink { background: var(--tint-pink); }
    /* mono-lg and page-mark-lg: the mark at a page heading's size, as on a patch's card. */
    .mono-lg { width: 56px; height: 56px; border-radius: 14px; box-shadow: 3px 3px 0 var(--ink); font-size: 1.05rem; }
    .page-mark { position: relative; flex: none; width: 26px; height: 32px; margin-inline: 4px; border: 2px solid var(--ink); border-radius: 3px 9px 3px 3px; background: var(--white); }
    .page-mark::after { content: ""; position: absolute; inset: 7px 5px 6px; background: repeating-linear-gradient(transparent 0 4px, var(--line-strong) 4px 6px); }
    /* After the base rules, which would otherwise win at equal specificity. */
    .page-mark-lg { width: 44px; height: 54px; margin-inline: 6px; border-radius: 4px 14px 4px 4px; box-shadow: 3px 3px 0 var(--ink); }
    .page-mark-lg::after { inset: 12px 9px 10px; background: repeating-linear-gradient(transparent 0 6px, var(--line-strong) 6px 8px); }
    mark { padding: 0 2px; border-radius: 3px; background: rgba(255, 191, 53, .6); color: var(--ink); }
    /* tag: a small label after a name, such as You. */
    .tag { display: inline-flex; align-items: center; min-height: 20px; margin-left: 6px; padding: 1px 7px; border: 1.5px solid var(--line-strong); border-radius: var(--radius-pill); color: var(--ink-soft); font-size: .7rem; font-weight: 800; letter-spacing: .04em; line-height: 1; text-transform: uppercase; vertical-align: 2px; }
    /* tag-new: something new to the viewer, in the brand's highlighter yellow. */
    .tag-new { border-color: var(--ink); background: var(--yellow); color: var(--ink); }
    /* shelf-label: a small capitalised label over a group inside a shelf or panel, such as New to you. */
    .shelf-label { margin: 14px 0 4px; color: var(--muted); font-size: .74rem; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    /* whats-new-dot: What's new has changes the viewer hasn't seen. */
    .whats-new-dot { position: absolute; top: 8px; right: 8px; width: 10px; height: 10px; border: 2px solid var(--ink); border-radius: 50%; background: var(--blue); }
    .field {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 44px;
      padding: 9px 12px;
      border: 1.5px solid var(--ink);
      border-radius: var(--field-radius);
      background: var(--white);
      color: var(--ink);
      font: inherit;
      font-size: .95rem;
    }
    /* field-group: a fixed field-prefix, such as the address a handle opens, before the editable input. The group
       draws the field and its focus ring; the prefix is a second label, so clicking it focuses the input. A long
       prefix wraps rather than squeezing the input below a few characters. */
    .field-group { display: flex; align-items: stretch; padding-block: 0; cursor: text; }
    .field-group > input { flex: 1; min-width: 8ch; padding: 9px 0; border: 0; background: transparent; color: inherit; font: inherit; }
    .field-group > input:focus-visible { outline: none; }
    .field-group:has(> input:focus-visible) { outline: 3px solid var(--blue); outline-offset: 3px; }
    /* kbd: a keycap, an ink frame with a key's depth as a hard bottom edge. Its glyph is drawn, not typed: ⌘ ⇧ ↵ are
       missing from many system fonts. kbd-sm sits in a row. */
    .kbd { display: inline-flex; align-items: center; justify-content: center; gap: 2px; flex: none; min-width: 26px; height: 24px; padding: 0 6px; border: 1.5px solid var(--ink); border-radius: 6px; background: var(--white); box-shadow: 0 2px 0 var(--ink); color: var(--ink); font: 850 .8rem/1 var(--font-sans); }
    .kbd svg { display: block; }
    .kbd-sm { min-width: 22px; height: 20px; padding: 0 4px; border-radius: 5px; box-shadow: 0 1.5px 0 var(--ink); }
    /* command: a search field over a listbox of rows to go to, such as the switcher's. The field is a field-group led by
       glyph-sm whose input is a combobox; it keeps focus and names the lit row through aria-activedescendant. A
       command-row is a link drawn as an option: its mark, command-title, an optional command-detail at its end, and
       the lit row's ↵ kbd. command-group gathers rows under a shelf-label command-head; command-head-patchy leads with
       the glyph, for Patchy's own places. command-empty says nothing matched. It resets what it holds, so it draws the
       same over an app page and over a running patch. */
    .command, .command * { box-sizing: border-box; }
    .command { display: flex; flex-direction: column; min-height: 0; overflow: hidden; border: 1.5px solid var(--ink); border-radius: 14px; background: var(--paper); box-shadow: var(--shadow-hard); color: var(--ink); font-family: var(--font-sans); font-size: 1rem; font-weight: 450; line-height: 1.3; text-align: left; }
    .command :is(p, a) { max-width: none; margin: 0; }
    .command-field.field { display: flex; align-items: center; gap: 12px; flex: none; min-height: 54px; padding: 0 18px; border: 0; border-bottom: 1.5px solid var(--line-strong); border-radius: 0; background: transparent; font-size: 1.05rem; }
    /* The caret is the field's focus: it holds focus for as long as the list is open. */
    .command-field.field:has(> input:focus-visible) { outline: none; }
    .command-field > input { align-self: stretch; padding: 0; font-weight: 650; }
    .command-field > input::placeholder { color: var(--muted); font-weight: 500; opacity: 1; }
    .command-list { display: flex; flex-direction: column; min-height: 0; padding: 6px; overflow-y: auto; overscroll-behavior: contain; scroll-padding-block: 6px; }
    .command-group { display: flex; flex-direction: column; }
    .command-row { display: flex; align-items: center; gap: 10px; flex: none; min-width: 0; min-height: 34px; padding: 4px 10px 4px 8px; border-radius: var(--field-radius); color: var(--ink); font-size: .92rem; font-weight: 600; text-decoration: none; cursor: pointer; }
    .command-row[aria-selected="true"] { background: color-mix(in srgb, var(--yellow) 45%, var(--white)); }
    .command-row .mono { width: 24px; height: 24px; border-width: 1.5px; border-radius: 6px; font-size: .55rem; }
    .command-row .page-mark { width: 19px; height: 24px; margin-inline: 2.5px; border-width: 1.5px; border-radius: 2px 7px 2px 2px; }
    .command-row .page-mark::after { inset: 5px 3.5px 4px; background: repeating-linear-gradient(transparent 0 3px, var(--line-strong) 3px 4.5px); }
    .command-icon { display: inline-grid; place-items: center; flex: none; width: 24px; height: 24px; }
    .command-icon svg { width: 17px; height: 17px; }
    .command-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .command-title > .whats-new-dot { position: static; display: inline-block; width: 8px; height: 8px; margin-left: 8px; border: 0; vertical-align: 1px; }
    .command-detail { flex: none; color: var(--muted); font-size: .8rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .command-row > .kbd { margin-left: -2px; }
    .command-head.shelf-label { display: flex; align-items: center; gap: 8px; flex: none; height: 30px; margin: 0; padding: 10px 10px 0; font-size: .68rem; }
    .command-head-patchy.shelf-label { color: var(--ink); }
    .command-head .glyph-sm { width: 14px; height: 14px; border-width: 1.5px; border-radius: 4px; box-shadow: 1.5px 1.5px 0 var(--ink); }
    .command-head .glyph-sm::after { top: 2px; right: 2px; width: 4px; height: 4px; border-width: 1.5px; }
    .command-empty { flex: none; padding: 20px 16px 4px; color: var(--ink-soft); font-size: .92rem; font-weight: 650; }
    /* A live region, so it stays in place, empty and without height, until it has something to say. */
    .command-empty:empty { padding: 0; }
    /* switcher: Mod+Shift+K's command list in a shell-scrim modal dialog, the same flat dim as the starting cover, anchored
       near the top so the field never moves as the list shrinks. Nothing about it animates. */
    .switcher[open] { place-items: start center; padding-top: min(96px, 10vh); }
    .switcher > .command { width: min(600px, 100%); max-height: calc(100dvh - 2 * min(96px, 10vh)); }
    /* note-inline: a note-float laid out as one row (text, actions, then any Hide) for the bottom-centre bar. */
    .note-inline { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 16px; max-width: 620px; }
    .note-inline:has(> .note-collapse) { grid-template-columns: minmax(0, 1fr) auto auto; }
    .note-inline .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; }
    /* Under 480px the bar becomes a full-width bottom sheet with its actions on a second row; chips stay centred pills above it. */
    @media (max-width: 480px) {
      .note-inline { grid-template-columns: minmax(0, 1fr); }
      .note-inline:has(> .note-collapse) { grid-template-columns: minmax(0, 1fr) auto; }
      .note-inline .actions { grid-column: 1 / -1; }
      .shell-bottom > .note-float {
        align-self: stretch;
        max-width: none;
        margin: 0 -16px -16px;
        border-radius: var(--radius) var(--radius) 0 0;
        box-shadow: none;
      }
      /* Downloads become bottom sheets too, stacked above the page state while it is up. */
      .shell-corner { right: 0; bottom: 0; width: 100%; max-height: calc(100dvh - 16px); gap: 8px; padding: 0; }
      body:has(.shell-bottom > :not([hidden])) .shell-corner {
        bottom: calc(var(--patchy-status-offset, 0px) + 8px);
        max-height: calc(100dvh - 24px - var(--patchy-status-offset, 0px));
      }
      .shell-downloads { gap: 8px; }
      .shell-corner details > .shell-downloads { margin-top: 8px; }
      .shell-corner summary { margin-right: auto; }
      .shell-corner .note-float { border-radius: var(--radius) var(--radius) 0 0; box-shadow: none; }
    }
`;
