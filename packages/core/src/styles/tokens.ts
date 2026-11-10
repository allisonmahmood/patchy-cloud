/**
 * The design tokens every chunk draws from: colour, type, size, shape and elevation. A visual
 * value outside this block is a finding; layout geometry (a grid's columns, a gap between two
 * particular things) is not.
 */
export const tokens = `
    :root {
      --paper: #fffdf4;
      --surface: #fffefa;
      --sunken: #f6f4eb;
      --hover: rgba(18, 17, 15, .05);
      --selected: #ffeec4;
      --chosen: #fffaea;
      --ink: #12110f;
      --text: #36332d;
      --muted: #5e5950;
      --placeholder: #69645a;
      --border-subtle: #e7e5dd;
      --border: #d9d7cf;
      --border-strong: #94938d;
      --blue: #1263e6;
      --blue-hover: #0f56c9;
      --link: #093b92;
      --yellow: #ffbf35;
      --green: #64c83f;
      --on-blue: #ffffff;
      --success: #2f6a17;
      --success-bg: #eff9e8;
      --success-line: #c7e3b5;
      --success-dot: #3f9a1c;
      --warning: #8a5300;
      --warning-bg: #fff7e4;
      --warning-line: #f0d49a;
      --danger: #9a1d0c;
      --danger-bg: #fdf0eb;
      --danger-line: #efc2b4;
      --danger-solid: #b4220f;
      --info: #093b92;
      --info-bg: #eaf5ff;
      --info-line: #b9d4f2;
      --tint-yellow: #ffd76e;
      --tint-green: #cdeebb;
      --tint-blue: #cfe4ff;
      --tint-amber: #ffe2a8;
      --tint-pink: #f6d3e4;
      --scrim: rgba(18, 17, 15, .32);
      --highlight: rgba(255, 191, 53, .6);
      --canvas-grid: rgba(18, 17, 15, .035);

      --font-ui: "Geist", "Geist Fallback", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      --font-display: var(--font-ui);
      --font-mono: "Geist Mono", ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;

      /* Seven sizes, four weights. */
      --text-title: 800 28px/34px var(--font-display);
      --text-title-sm: 800 22px/28px var(--font-display);
      --text-title-phone: 800 24px/30px var(--font-display);
      --text-display-code: 600 30px/36px var(--font-mono);
      --text-section: 600 16px/24px var(--font-ui);
      --text-prose: 400 15px/24px var(--font-ui);
      --text-body: 400 14px/20px var(--font-ui);
      --text-label: 500 14px/20px var(--font-ui);
      --text-meta: 400 13px/18px var(--font-ui);
      --text-badge: 500 12px/16px var(--font-ui);
      --text-code: 400 13px/20px var(--font-mono);
      /* Inline code in running text: 13px in a 14px line, scaling with the line it sits in. */
      --size-code: .929em;
      /* The body's line, for smaller text set level with body text beside it. */
      --line-body: 20px;
      --weight-regular: 400;
      --weight-medium: 500;
      --weight-strong: 600;
      --weight-title: 800;

      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 24px;
      --space-6: 32px;
      --space-7: 48px;
      --space-8: 64px;

      --h-control: 36px;
      --h-sm: 32px;
      --h-row: 44px;
      --h-row-2: 56px;
      --field-text: 14px;
      --field-text-mono: 13px;
      --h-tab: 40px;
      --h-seg: 28px;
      --h-chip: 30px;
      --h-textarea: 92px;
      --h-command: 52px;

      --r-control: 6px;
      --r-container: 10px;
      --r-modal: 12px;
      --r-round: 999px;
      --r-inline: 4px;
      --r-highlight: 3px;

      --lift: 2px 2px 0 var(--ink);
      --lift-tile: 3px 3px 0 var(--ink);
      --float: 4px 4px 0 var(--ink);
      --modal: 6px 6px 0 var(--ink);
      --lift-sm: 1.5px 1.5px 0 var(--ink);
      --key: 0 2px 0 var(--ink);
      --key-sm: 0 1px 0 var(--ink);

      --w-index: 1120px;
      --w-settings: 760px;
      --w-flow: 640px;
      --w-dialog: 480px;
      --w-dialog-md: 560px;
      --w-door: 440px;
      --w-prose: 34em;
    }
    /* Touch: every control a finger's width, and field text that phones won't zoom into. */
    @media (pointer: coarse) {
      :root { --h-control: 44px; --h-sm: 44px; --h-row: 52px; --h-row-2: 64px; --field-text: 16px; --field-text-mono: 16px; --h-tab: 44px; --h-seg: 44px; --h-chip: 44px; }
    }
`;
