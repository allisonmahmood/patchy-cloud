/**
 * Marks: the Patchy glyph, patches (rounded squares: initials for a tool, a ruled sheet for a
 * page), people (circles) and other products (white squares). Flat in lists; the tilt and hard
 * shadow belong to the glyph and to a mark at hero size only.
 */
export const marks = `
    .glyph {
      position: relative; display: inline-block; flex: none;
      width: 24px; height: 24px;
      border: 2px solid var(--ink); border-radius: 7px;
      background: var(--green);
      box-shadow: var(--lift);
      transform: rotate(-6deg);
    }
    .glyph::after {
      content: ""; position: absolute; top: 4px; right: 4px; width: 7px; height: 7px;
      border-top: 2px solid var(--ink); border-right: 2px solid var(--ink); border-top-right-radius: 1px;
    }
    .glyph-lg { width: 36px; height: 36px; border-radius: 10px; box-shadow: var(--lift-tile); }
    .glyph-lg::after { top: 7px; right: 7px; width: 10px; height: 10px; }

    .brand { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--ink); font-weight: var(--weight-strong); text-decoration: none; }

    .mono, .pm {
      display: inline-grid; place-items: center; flex: none;
      width: 28px; height: 28px;
      border: 1px solid var(--ink); border-radius: 7px;
      background: var(--tint-yellow);
      color: var(--ink);
      font: 600 11px/1 var(--font-ui); letter-spacing: .02em;
    }
    .mono-blue, .pm-blue { background: var(--tint-blue); }
    .mono-green, .pm-green { background: var(--tint-green); }
    .mono-amber, .pm-amber { background: var(--tint-amber); }
    .mono-pink, .pm-pink { background: var(--tint-pink); }
    .mono-md, .pm-md { width: 36px; height: 36px; border-radius: 9px; font-size: 13px; }
    .mono-lg, .pm-lg {
      width: 52px; height: 52px; border: 2px solid var(--ink); border-radius: 12px;
      box-shadow: var(--lift-tile); font-size: 17px; transform: rotate(-3deg);
    }
    .mono-placeholder { border-style: dashed; border-color: var(--border-strong); background: transparent; color: var(--muted); }
    /* A page: a ruled sheet in a patch mark's square. */
    .page-mark {
      position: relative; display: inline-block; flex: none;
      width: 28px; height: 28px;
      border: 1px solid var(--ink); border-radius: 7px;
      background: var(--surface);
    }
    .page-mark::after { content: ""; position: absolute; inset: 8px 7px; background: repeating-linear-gradient(transparent 0 3px, var(--border-strong) 3px 4.5px); }
    .page-mark-lg { width: 52px; height: 52px; border: 2px solid var(--ink); border-radius: 12px; box-shadow: var(--lift-tile); transform: rotate(-3deg); }
    .page-mark-lg::after { inset: 14px 12px; background: repeating-linear-gradient(transparent 0 5px, var(--border-strong) 5px 7px); }

    .avatar, .av {
      display: inline-grid; place-items: center; flex: none;
      width: 32px; height: 32px; border-radius: 50%;
      background: var(--tint-blue); box-shadow: inset 0 0 0 1px rgba(18, 17, 15, .18);
      color: var(--ink); font: 600 12px/1 var(--font-ui); letter-spacing: .02em;
    }
    .avatar-green, .av-green { background: var(--tint-green); }
    .avatar-amber, .av-amber { background: var(--tint-amber); }
    .av-pink { background: var(--tint-pink); }
    .av-sm { width: 24px; height: 24px; font-size: 10px; }
    .avatar-waiting, .av-waiting { background: var(--surface); box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--muted); }
    .avatar-off, .av-off { background: var(--sunken); color: var(--muted); }

    .agent-mark, .im {
      display: inline-grid; place-items: center; flex: none;
      width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 8px;
      background: var(--surface); color: var(--ink);
      font: 700 12px/1 var(--font-ui); letter-spacing: -.01em;
    }
    .agent-mark svg { width: 18px; height: 18px; }
    .im-lg { width: 48px; height: 48px; border: 2px solid var(--ink); border-radius: 11px; box-shadow: var(--lift-tile); font-size: 17px; }
    .im-dashed { border-style: dashed; border-color: var(--border-strong); color: var(--muted); }
`;
