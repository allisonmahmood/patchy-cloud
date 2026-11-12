import {
  agentMark,
  avatar,
  choiceCards,
  menuCopy,
  menuLink,
  patchMark,
  rowMenu,
  searchField,
  tileOptions
} from "../components.js";
import { copyLine, copyScriptPath } from "../copy-line.js";
import { displayFont, hasDisplayFont } from "../fonts.js";
import { tokens } from "../styles/tokens.js";
import { escapeHtml } from "../escape.js";
import {
  button,
  checkbox,
  choiceGroup,
  field,
  iconButton,
  input,
  linkButton,
  prefixInput,
  radio,
  secretInput,
  select,
  switchForm,
  textarea
} from "./controls.js";
import { attentionRow } from "./attention.js";
import { behindTheScenes, changeEntry } from "./changelog.js";
import { choiceLinks } from "./choice-links.js";
import { computerMark } from "./computer-mark.js";
import { copyButton } from "./copy-button.js";
import { disclosure } from "./disclosure.js";
import { changeBar } from "./change-bar.js";
import { checklist } from "./checklist.js";
import {
  chipMenu,
  codeRow,
  groupedTable,
  menuNewTab,
  menuRule,
  person,
  refusalNotice,
  settingsPanel
} from "./detail.js";
import { answerPair, canList, meet, verificationCode } from "./door.js";
import { region } from "./region.js";
import { badge, dot, emptyState, notice, receipt, unopenedName } from "./feedback.js";
import { expandingTable } from "./expanding-table.js";
import { fieldRow } from "./field-row.js";
import { flowOutcome } from "./flow-outcome.js";
import { productLogos, type ProductLogo } from "./logos.js";
import { listDetail } from "./list-detail.js";
import { productMark } from "./product-mark.js";
import { refusal } from "./refusal.js";
import {
  card,
  chip,
  dialog,
  facts,
  menu,
  row,
  rows,
  section,
  segmented,
  settingRow,
  steps,
  table,
  tabs
} from "./structure.js";
import {
  detailPage,
  doorPage,
  flowPage,
  indexPage,
  settingsPage,
  type Template
} from "./templates.js";
import { usualTiles } from "./usual.js";

/**
 * The `/~ui` gallery, development only: every helper in each state it has, a state table per
 * component, and one page per template drawn from sample data. It is what a page should look like
 * when it composes the system, and where a change to the system is seen first.
 */
export const galleryPath = "/~ui";

/**
 * The gallery's pages: the system, each template, the states that take the page's focus or end
 * a door, each on a page of its own, and dialogs over the system.
 */
export const galleryPages = [
  "",
  "index",
  "detail",
  "refused",
  "settings",
  "flow",
  "checklist-refused",
  "checklist-none",
  "door",
  "door-refused",
  "door-field",
  "door-outcome",
  "door-unavailable",
  "consent",
  "dialog",
  "final"
] as const;
export type GalleryPage = (typeof galleryPages)[number];

const link = (page: GalleryPage) => (page === "" ? galleryPath : `${galleryPath}/${page}`);

/** One component's states, as a reviewer checks them. */
const stateTable = (
  component: string,
  states: ReadonlyArray<readonly [state: string, how: string]>
) =>
  table({
    label: `${component} states`,
    columns: [{ label: "State" }, { label: "How it looks" }],
    rows: states.map(([state, how]) => [
      `<span class="strong">${escapeHtml(state)}</span>`,
      escapeHtml(how)
    ])
  });

const demo = (title: string, body: string, states?: string) =>
  section({ title, body: `<div class="box box-pad">${body}</div>${states ?? ""}` });

const patch = (name: string, tier = 2) => patchMark(name, tier);

/** The face titles draw in on this instance: the display font where it has the file. */
const titleFace = hasDisplayFont ? displayFont.family : "Geist";

const type = demo(
  "Type",
  table({
    label: "Type roles",
    columns: [{ label: "Role" }, { label: "Sample" }],
    rows: (
      [
        [`Page title · ${titleFace} 28/34 · 800`, '<span class="title">New Business</span>'],
        [
          `Dialog and door title · ${titleFace} 22/28 · 800`,
          '<span class="title-sm">Invite people</span>'
        ],
        ["Section title · 16/24 · 600", '<span class="section-title">Recent activity</span>'],
        [
          "Prose · 15/24 · at most 34em",
          '<span class="prose">Every pitch from first lead to signed work.</span>'
        ],
        [
          "Body and names · 14/20 · 400 and 600",
          '<span><span class="strong">Spend Requests</span> · request and approve spend</span>'
        ],
        ["Label, button, nav · 14/20 · 500", '<span class="label">Connection string</span>'],
        [
          "Meta, hint, table header · 13/18",
          '<span class="meta">Used 2 min ago · expires 7 Dec unless used</span>'
        ],
        ["Badge · 12/16 · 500", badge("Needs attention", "danger")],
        ["Code · Geist Mono 13/20", "<code>patchy add attio/crm</code>"]
      ] satisfies ReadonlyArray<readonly [string, string]>
    ).map(([role, sample]) => [escapeHtml(role), sample])
  })
);

/**
 * The token block's colours, drawn from its own values so the gallery never disagrees with it, and
 * the canvas, which this page itself sits on.
 */
const colours = demo(
  "Colour",
  table({
    label: "Colours",
    columns: [{ label: "Swatch", hidden: true }, { label: "Token" }, { label: "Value" }],
    rows: [...tokens.matchAll(/(--[a-z-]+): (#[0-9a-f]{6});/g)].map(([, name, value]) => [
      `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x=".5" y=".5" width="23" height="23" rx="6" fill="${value}" stroke="${tokens.match(/--border: (#[0-9a-f]{6})/)![1]}"/></svg>`,
      `<code>${escapeHtml(name!)}</code>`,
      `<span class="meta">${escapeHtml(value!)}</span>`
    ])
  }),
  stateTable("Canvas", [
    [
      "Page",
      "squared paper, 32px squares over a blue → cream → green wash, behind every door and app page, as behind this one; it scrolls with the page"
    ],
    [
      "Own surface",
      "what is bordered, pressed or floats: the sidebar and top bar, the door card, boxes, cards, tiles, notices, controls, menus, dialogs and the switcher"
    ],
    [
      "On the paper",
      "everything else, such as tables, lists, prose, a flow's sections and every title, with the squares behind it"
    ],
    ["Hover", "a row on the paper takes a translucent tint; a tile tints over its own surface"],
    ["Forced colours", "the squares and the wash drop away"]
  ])
);

const buttons = demo(
  "Buttons",
  `<div class="stack"><div class="btn-group">${linkButton("Open", "#buttons", { kind: "primary", icon: "external" })}${button("Share", { type: "button", icon: "share" })}${button("Cancel", { type: "button", kind: "quiet" })}${button("Delete…", { type: "button", kind: "danger", icon: "trash" })}${button("Delete New Business", { type: "button", kind: "danger-solid" })}</div><div class="btn-group">${button("Save", { type: "button", kind: "primary", size: "sm" })}${button("Reassign…", { type: "button", size: "sm" })}${iconButton("More", "more")}${iconButton("Copy", "copy")}${button("Opens panel", { type: "button", size: "sm", popovertarget: "g-panel", icon: "message" })}<div class="menu" id="g-panel" popover><p class="menu-head"><strong>A panel</strong>Opened by its button</p></div>${button("Testing…", { type: "button", kind: "primary", pending: true })}<form method="post" action="${link("flow")}">${button("Test", { size: "sm", pendingLabel: "Testing…" })}</form></div></div>`,
  stateTable("Button", [
    ["Rest", "2px ink edge; primary is blue with a 2px hard shadow"],
    ["Hover (fine pointer)", "lifts 1px into a deeper shadow; quiet and icon buttons tint instead"],
    ["Pressed", "sinks into its shadow"],
    ["Focus", "2px ink ring, 2px out"],
    [
      "Pending",
      "with a pending label, the pressed submit says it, such as Testing…, static, aria-disabled; it holds room for the longer label from the start, so nothing moves, and its form takes no second submit until the page answers (Test here, Test and connect on the Flow page)"
    ],
    [
      "Opens a panel",
      "a button may name a popover it opens or closes, such as Ask for an integration opening Tell Patchy (the Opens panel button here)"
    ],
    ["Touch", "44px tall"]
  ])
);

const fields = demo(
  "Fields",
  `<div class="fields">${field({ id: "g-name", label: "Name", control: (aria) => input(aria, { name: "name", value: "Brightline Studio" }) })}${field({ id: "g-desc", label: "Description", hint: "One line on what this database is for.", optional: true, control: (aria) => input(aria, { name: "description" }) })}${field({ id: "g-handle", label: "Name", hint: "Patches use this name, which can't be changed later.", error: "Lowercase letters, digits and hyphens only.", control: (aria) => prefixInput(aria, { name: "handle", prefix: "attio/", value: "CRM Main", exact: true }) })}${field({ id: "g-key", label: "Access token", control: (aria) => secretInput(aria, { name: "key", value: "secret-sample-value", autocomplete: "off" }) })}${field(
    {
      id: "g-role",
      label: "Role",
      control: (aria) =>
        select(aria, {
          name: "role",
          value: "member",
          width: "sm",
          choices: [
            { value: "member", label: "Member" },
            { value: "admin", label: "Admin" }
          ]
        })
    }
  )}${choiceGroup({ id: "g-plan", legend: "Plan", error: "Pick a plan.", choices: (aria) => `${radio({ name: "plan", value: "team", label: "Team", aria })}${radio({ name: "plan", value: "company", label: "Company", aria })}` })}${field({ id: "g-note", label: "Emails", hint: "One per line.", control: (aria) => textarea(aria, { name: "emails", grow: true }) })}${choiceGroup({ id: "g-tell-kind", legend: "Request or feedback", hideLegend: true, choices: (aria) => `${radio({ name: "tell", value: "request", label: "Request", checked: true, aria })}${radio({ name: "tell", value: "feedback", label: "Feedback", aria })}` })}${field({ id: "g-tell", label: "What to tell Patchy", hideLabel: true, control: (aria) => textarea(aria, { name: "tell", rows: 3 }) })}${choiceGroup({ id: "g-access", legend: "Who can open it", choices: `${radio({ name: "access", value: "company", label: "People at Acme Co", checked: true })}${radio({ name: "access", value: "public", label: "Anyone on the internet" })}${checkbox({ name: "remember", value: "1", label: "Remember this computer", checked: true })}` })}${choiceGroup(
    {
      id: "g-mode",
      legend: "Patches may",
      choices: choiceCards("g-mode", [
        { value: "read", title: "Read", points: ["Its mail and labels", "Nothing changes"] },
        { value: "send", title: "Read and send", points: ["Also reply and send"], checked: true }
      ])
    }
  )}${field({ id: "g-invite", label: "Invite a guest", control: (aria) => `<div class="pair"><span class="grow">${input(aria, { name: "email", type: "email", placeholder: "Email of someone at another company" })}</span>${button("Invite", { type: "button", kind: "primary" })}</div>` })}<div class="fieldset"><span class="field-label">Copy line</span>${copyLine("patchy add attio/crm", "Command", "the command")}</div></div>`,
  `${stateTable("Field", [
    ["Rest", "1px ink edge at button height, surface fill"],
    ["Focus", "2px ink ring outside and a 1px ink edge inside"],
    ["Refused", "danger edge, aria-invalid, the error under it, linked by aria-describedby"],
    ["Prefix", "the fixed part fused before the input, a label that focuses it"],
    [
      "Exact",
      "what is typed exactly, such as a handle: a phone neither capitalises nor corrects it"
    ],
    ["Secret", "masked; Show appears with script and toggles the mask"],
    [
      "Hidden label",
      "the label or legend kept for readers, out of sight, where what holds the field names it, such as Tell Patchy's panel"
    ],
    [
      "Live hint",
      "a part of the hint follows what is typed, or its example while empty, such as the name on the Flow page; without script it shows what was submitted"
    ],
    ["Touch", "44px tall with 16px text, so phones don't zoom"]
  ])}${stateTable("Copy line", [
    ["Without script", "the line alone, selectable whole; Copy stays hidden"],
    ["Ready", "Copy, a compact secondary button, revealed by the copy script"],
    ["Copied", "Copy reads Copied for two seconds"],
    ["Refused by the browser", "Copy reads Select the line to copy"]
  ])}`
);

const choices = demo(
  "Choices and switches",
  `<div class="stack">${choiceGroup({
    id: "g-address",
    legend: "Address",
    choices: tileOptions("g-address", [
      {
        value: "sales",
        name: "sales@acme.example",
        text: "Connected to this key",
        mark: patchMark("sales", 2),
        checked: true
      },
      {
        value: "help",
        name: "help@acme.example",
        text: "Already connected",
        mark: patchMark("help", 2),
        disabled: true
      },
      {
        value: "new",
        name: "New address",
        text: "On your domains",
        mark: '<span class="mono mono-placeholder" aria-hidden="true">+</span>',
        placeholder: true
      }
    ])
  })}${rows([settingRow({ title: "Agents use patches", description: "On", control: switchForm({ action: "#choices", label: "Agents use patches", checked: true }) }), settingRow({ title: "Guests can use it", description: "Off", control: switchForm({ action: "#choices", label: "Guests can use it", checked: false }) }), settingRow({ title: "Agent access", description: "Read-only for members", control: '<span class="muted">On · only admins can change this</span>' })], true)}</div>`,
  `${stateTable("Choice", [
    ["Unchecked", "native radio or checkbox in ink, or a framed row or card"],
    ["Checked", "filled ink control; a row or card takes a 2px ink edge on pale yellow"],
    ["Disabled", "faded and not pressable, such as an address already connected"],
    ["Focus", "the ring on the drawn row or card, the native control kept for keys and readers"]
  ])}${stateTable("Switch", [
    ["On", "ink track, yellow knob at the end; aria-checked true"],
    ["Off", "sunken track, knob at the start; aria-checked false"],
    ["Pressed", "posts the other state as a one-button form"],
    ["Read-only", "the value as text and who can change it, never a disabled switch"]
  ])}`
);

const status = demo(
  "Status",
  `<div class="stack"><div class="cluster"><span class="muted">None</span><span class="muted">No calls yet</span>${badge("2 failed", "danger")}</div><div class="cluster"><span class="muted">Succeeded</span>${badge("Failed", "danger")}${badge("Refused", "warning")}${badge("Running", "info")}${badge("Unknown")}</div><div class="cluster">${dot("Connected", "success")}${badge("Needs attention", "danger")}${badge("Paused")}${badge("Serving", "yellow")}</div><div class="cluster">${badge("Invited")}${badge("Guest")}<span class="you">(you)</span>${badge("Expires soon", "warning")}<span class="row-name">${unopenedName("Pitch Library")}</span></div></div>`,
  stateTable("Status", [
    [
      "Quiet",
      "plain text or a dot with its word, for routine states such as Succeeded or Connected"
    ],
    ["Needs a decision", "a badge on its tone: danger, warning, info"],
    ["Plain badge", "a state to note, such as Paused or Invited"],
    ["Not opened yet", "a blue dot after a colleague's patch's name, named for readers"]
  ])
);

const feedback = demo(
  "Feedback",
  `<div class="stack">${receipt("Invited 2 people as members.")}${notice({ tone: "info", title: "Agent access is off at Acme Co", body: "<p>Ada Lovelace can turn it on.</p>" })}${notice({ tone: "warning", title: "This key expires in 3 days", body: "<p>Replace it before then so patches keep reading.</p>", action: button("Replace…", { type: "button", size: "sm" }) })}${notice({ tone: "danger", title: "Pidgeon refused the key", body: "<p>Someone revoked it in Pidgeon. Paste a new admin key to reconnect.</p>", action: button("Reconnect", { type: "button", size: "sm", kind: "primary" }) })}<div class="box">${emptyState({ title: "No computers yet", body: "Give your agent one line and it can build and publish patches.", action: linkButton("Add a computer", "#feedback", { size: "sm", icon: "plus" }) })}</div></div>`,
  `${stateTable("Receipt", [
    ["Shown", "once, at the top of the page the form lands on, as a status"],
    ["Undo", "not offered: retire and delete confirm first, and restore lives on the patch's page"]
  ])}${stateTable("Empty state", [
    ["Empty", "what is missing where the content will be, and at most one way to start"]
  ])}${stateTable("Notice", [
    ["Info", "blue paper, status"],
    ["Warning", "amber paper, status"],
    ["Danger", "red paper, alert"],
    ["Success", "never a notice: a receipt says what the form did"]
  ])}`
);

const navigation = demo(
  "Navigation and filtering",
  `<div class="stack">${tabs({
    label: "Patch",
    current: "Overview",
    items: [
      { label: "Overview", href: "#navigation" },
      { label: "Log", href: "#navigation" },
      { label: "Versions", href: "#navigation", count: 3 },
      { label: "Settings", href: "#navigation" }
    ]
  })}<div>${segmented({
    label: "Show",
    current: "All",
    items: [
      { label: "All", href: "#navigation", count: 12 },
      { label: "Tools", href: "#navigation", count: 9 },
      { label: "Pages", href: "#navigation", count: 3 },
      { label: "Yours", href: "#navigation", count: 5 }
    ]
  })}</div><div class="cluster">${chip({ key: "Outcome", value: "Any", href: "#navigation" })}${chip({ value: "Failed", href: "#navigation", on: true })}${chip({ key: "Person", value: "Anyone", href: "#navigation" })}</div></div>`,
  stateTable("Tabs, segmented, chips", [
    [
      "Current",
      "tab: ink underline, 600; segment: raised with an ink edge; chip: yellow with an ink edge"
    ],
    ["Hover (fine pointer)", "ink text"],
    ["Focus", "2px ink ring, inside a strip that scrolls"],
    [
      "Opens a panel",
      "a button may name a popover it opens or closes, such as Ask for an integration opening Tell Patchy (the Opens panel button here)"
    ],
    ["Touch", "44px tall"]
  ])
);

const listMenu = menu({
  id: "g-kudos",
  label: "Kudos",
  items: [
    { kind: "link", label: "Open", href: "#rows" },
    { kind: "copy", label: "Copy link", text: "https://example.com/acme/kudos" },
    { kind: "link", label: "Share…", href: "#rows" },
    { kind: "rule" },
    { kind: "link", label: "Delete…", href: "#rows", danger: true }
  ]
});

const lists = demo(
  "Rows, tables and menus",
  `<div class="stack">${rows([row({ lead: patch("kudos"), name: "Kudos", href: "#rows", description: "Give a colleague a shout-out", end: listMenu }), row({ lead: agentMark, name: "Claude", description: "Connected 3 Nov · last call 2 h ago", end: button("Disconnect", { type: "button", size: "sm" }) }), row({ lead: patch("brief", 1), name: "Kickoff brief", description: "A page" })], true)}${table(
    {
      label: "People",
      columns: [
        { label: "Person" },
        { label: "Role", hideOnPhone: true },
        { label: "Patches", align: "end" },
        { label: "Actions", hidden: true }
      ],
      rows: [
        [
          `<div class="cell-name">${avatar("ada@example.com", "Ada Lovelace")}<div class="row-main"><a class="row-link" href="#rows">Ada Lovelace</a><span class="row-desc">ada@example.com</span></div></div>`,
          "Admin",
          "4",
          menu({
            id: "g-ada",
            label: "Ada Lovelace",
            items: [
              { kind: "link", label: "See their patches", href: "#rows" },
              { kind: "post", label: "Make member", action: "#rows" }
            ]
          })
        ],
        [
          `<div class="cell-name">${avatar("grace@example.com", "Grace Hopper")}<div class="row-main"><span class="row-name">Grace Hopper</span><span class="row-desc">grace@example.com</span></div></div>`,
          "Member",
          "0",
          ""
        ]
      ]
    }
  )}${facts([
    ["Owner", "Ada Lovelace"],
    ["Version", "v3, published 2 days ago"],
    ["Who can open it", "People at Acme Co"]
  ])}</div>`,
  `${stateTable("Row", [
    ["Rest", "on a hairline, no shadow"],
    [
      "Hover (fine pointer, with a link)",
      "a faint tint; the whole row opens it, its own buttons and menu still pressable"
    ]
  ])}${stateTable("Table", [
    ["Rest", "muted 13px headers over 56px rows on hairlines"],
    ["Phone", "columns marked for it are left out; a wide table scrolls in its own wrapper"],
    [
      "Narrow",
      "the growing column and a column of sentences keep a floor, so no word breaks; the table scrolls"
    ],
    ["Linked row", "the first cell's link covers the row"]
  ])}${stateTable("Menu", [
    ["Closed", "a quiet ⋯ button named for its row"],
    [
      "Open",
      "a native popover with an ink edge and a hard shadow, under its button where the browser anchors it"
    ],
    ["Item", "a link, or a button in its own form; danger items in red"],
    ["New tab", "Open in a new tab, named for whose it is"],
    ["Rule", "a hairline between everyday items and destructive ones"],
    ["Escape", "closes it and focus returns to its button"]
  ])}${stateTable("Facts", [
    ["Rest", "muted labels beside values, one pair a line"],
    ["Phone", "each label above its value"]
  ])}`
);

const wideParts = demo(
  "Search, paired fields and tables that open",
  `<div class="stack">${searchField({ action: "#wide-parts", id: "g-search", query: "", placeholder: "Search patches", label: "Search patches" })}${searchField({ action: "#wide-parts", id: "g-search-kept", query: "kudos", placeholder: "Search patches", label: "Search patches, keeping the filter", keep: { show: "yours" } })}${fieldRow([field({ id: "g-host", label: "Server", control: (aria) => input(aria, { name: "host", value: "imap.example.com", mono: true, exact: true }) }), field({ id: "g-port", label: "Port", error: "Use 993.", control: (aria) => input(aria, { name: "port", value: "143", inputmode: "numeric", width: "xs" }) })])}${expandingTable(
    {
      label: "Calls",
      compact: true,
      columns: [
        { label: "When" },
        { label: "Call" },
        { label: "Outcome" },
        { label: "Took", align: "end", hideOnPhone: true }
      ],
      rows: [
        {
          cells: ["10:42", "<code>records.list</code>", badge("Failed", "danger"), "1.2 s"],
          detail: {
            summary: "Details",
            body: facts([
              ["Call", "call_7f2a"],
              ["Said", "The key can't read lists."]
            ])
          }
        },
        {
          cells: [
            "10:40",
            "<code>records.get</code>",
            '<span class="muted">Succeeded</span>',
            "84 ms"
          ]
        }
      ]
    }
  )}</div>`,
  `${stateTable("Search field", [
    ["Empty", "the search icon fused before the field, the placeholder saying what it searches"],
    [
      "Searched",
      "the query kept in the field; the filters it sits beside ride along as hidden fields"
    ],
    [
      "In a form",
      "the same field inside a page's form, its icon the form's first submit, so Enter searches and the form's ticks ride along"
    ],
    ["Touch", "44px tall with 16px text"]
  ])}${stateTable("Field row", [
    ["Rest", "fields that belong together side by side, one with an answer width keeping it"],
    ["Refused", "each field keeps its own error under it"],
    ["Narrow", "each field on its own line"]
  ])}${stateTable("Expanding table", [
    ["Closed", "a row, then its summary across every column, read as one row"],
    ["Open", "the summary opens its details under the row, in place"],
    ["Compact", "40px rows, as a log's"],
    ["Phone", "columns marked for it are left out; a wide one scrolls in its own wrapper"]
  ])}`
);

const marks = demo(
  "Marks",
  `<div class="cluster">${'<span class="glyph glyph-lg" aria-hidden="true"></span><span class="glyph" aria-hidden="true"></span>'}${patchMark("new-business", 2, true)}${patch("spend")}${patch("kudos")}${patchMark("brief", 1, true)}${patch("brief", 1)}${avatar("ada@example.com", "Ada Lovelace")}${avatar("grace@example.com", "Grace Hopper")}${avatar("invite@example.com", "invite@example.com", "waiting")}${avatar("gone@example.com", "Ex Member", "off")}${agentMark}</div>`,
  stateTable("Marks", [
    ["Glyph", "Patchy's mark, tilted with its shadow"],
    [
      "Patch",
      "a rounded square: initials for a tool, a ruled sheet for a page; tilted and lifted only at hero size"
    ],
    ["Person", "a circle of initials; dashed for an invitation, faded for someone deactivated"],
    ["Another product", "a white square on a hairline"]
  ])
);

const setupSteps = demo(
  "Steps",
  steps([
    { title: "Give your agent this line", state: "done" },
    {
      title: "Confirm it's you",
      state: "current",
      body: '<p class="meta">Your agent sends a link and a code.</p>'
    },
    { title: "Ask for something", state: "later" }
  ]),
  stateTable("Steps", [
    ["Done", "an ink circle with a check"],
    ["Current", "a yellow circle, aria-current=step"],
    ["Later", "a muted circle and title"]
  ])
);

const headers = demo(
  "Headers and sections",
  `${rows([row({ name: "A page header", href: link("detail"), description: "Parent link, hero mark, title, meta and status lines, actions: see the Detail template" })], true)}${section({ title: "Recent activity", description: "The last three calls.", action: linkButton("See the log", "#headers", { size: "sm" }), body: '<p class="meta">Ada Lovelace · sample.load · Succeeded</p>' })}`,
  `${stateTable("Page header", [
    ["Parent", "a quiet link up one level, from two levels down"],
    ["Mark", "the object's mark at hero size, tilted and lifted"],
    [
      "Meta and status",
      "one muted line of facts; a status line only when there is something to say"
    ],
    ["Actions", "at most one primary; under the title on a phone"]
  ])}${stateTable("Section", [
    [
      "Rest",
      "a section title, an optional one-line description and an action at its end, then its content"
    ],
    ["Empty", "an empty state where its content will be"]
  ])}`
);

const cards = demo(
  "Cards and dialogs",
  `<div class="stack">${card({ title: "Owner", rows: [settingRow({ title: "Ada Lovelace", description: "Can publish, change and take it down.", control: button("Reassign…", { type: "button", size: "sm" }) })] })}${card({ title: "Take it down", danger: true, rows: [settingRow({ title: "Delete", description: "Gone for good 30 days later.", control: button("Delete…", { type: "button", size: "sm", kind: "danger" }) })] })}${rows([row({ name: "A dialog over its page", href: link("dialog"), description: "Closes with Escape or Close" }), row({ name: "A dialog only its actions close", href: link("final"), description: "Like the Final step" })], true)}</div>`,
  `${stateTable("Setting row", [
    ["Control", "what it is on the left, its control on the right"],
    ["Read-only", "its value as text and who can change it, for someone who can't"],
    ["Phone", "the control under its words"]
  ])}${stateTable("Card", [
    [
      "Settings",
      "a hairline container of setting rows, its own form with its own Save in a sunken foot"
    ],
    ["Danger zone", "last on the page, set apart, its title in red"]
  ])}${stateTable("Dialog", [
    [
      "Open",
      "over its page, which goes inert behind a static scrim; focus on its autofocus control"
    ],
    [
      "Close",
      "Escape or Close: back to the page it was opened from, or to its own page when loaded directly"
    ],
    [
      "Not dismissible",
      "no Close and no Escape, only its own actions, such as the Final step's Later"
    ],
    ["Phone", "a bottom sheet"],
    ["Long name", "an unbroken name breaks anywhere, so Close stays on a phone"],
    ["Without script", "the dialog is the page; Close is a link back"]
  ])}`
);

const disclosures = demo(
  "Disclosures",
  disclosure(
    "No agent yet?",
    '<p class="prose" id="g-disclosure-answer">Claude Code, Codex or Cursor each run on your computer and can build patches.</p><p class="meta">Install one, then give it the setup line.</p>'
  ),
  stateTable("Disclosure", [
    ["Closed", "the summary, with the browser's marker"],
    ["Open", "its parts under the summary, on one gap"],
    ["From a link", "a fragment naming something inside opens it, with script"]
  ])
);

const homeParts = demo(
  "Attention rows, usual tiles and copy buttons",
  `<div class="stack">${rows(
    [
      attentionRow({
        lead: patch("new-business"),
        name: "New Business",
        href: "#rows",
        problem: "2 calls failed in the last 24 hours",
        fix: linkButton("View log", "#rows", { size: "sm" })
      }),
      attentionRow({
        name: "imap/support",
        href: "#rows",
        problem: "The mail server refused the password",
        detail: "Paused",
        fix: linkButton("Replace password…", "#rows", { size: "sm" })
      })
    ],
    true
  )}${region({
    id: "g-usual",
    title: "Your usual",
    body: usualTiles(
      (
        [
          ["new-business", "New Business", "Tool · You", 2],
          ["spend", "Spend requests", "Tool · Grace", 2],
          ["brief", "Kickoff brief", "Page · Ada", 1],
          ["kudos", "Kudos", "Tool · Grace", 2]
        ] as const
      ).map(([name, title, meta, tier]) => ({
        mark: patch(name, tier),
        name: title,
        meta,
        href: "#rows"
      }))
    )
  })}<div class="cluster">${copyButton("https://example.com/acme/kudos", { label: "Copy link", ariaLabel: "Copy link to Kudos", size: "sm" })}<code>acme/kudos</code>${copyButton("acme/kudos", { kind: "quiet", size: "sm", ariaLabel: "Copy the address" })}</div></div>`,
  `${stateTable("Region", [
    ["Rest", "a section whose title names it as a landmark, for a page of several"]
  ])}${stateTable("Attention row", [
    ["Rest", "what broke in danger text, a quiet detail, and the one fix at its end"],
    ["Linked", "the whole row opens what broke; the fix stays pressable above it"]
  ])}${stateTable("Usual tile", [
    ["Rest", "flat on a hairline: the mark, then the name over its kind and owner"],
    ["Hover (fine pointer)", "an ink edge and a lift"],
    ["Narrow", "two a row; on a phone the name alone"]
  ])}${stateTable("Copy button", [
    ["Without script", "not there, so nothing offers a copy that can't happen"],
    ["With script", "its label, then Copied"],
    ["Quiet", "no frame, for a line's own Copy, such as an address in a header's meta"]
  ])}`
);

const changes = demo(
  "What's new changes",
  `${changeEntry({ id: "g-change-new", href: "#g-change-new", kind: "New", title: "Jump anywhere with ⌘⇧K", detail: "Press ⌘⇧K on any Patchy page to open Go to….", unseen: true })}${changeEntry({ id: "g-change-seen", href: "#g-change-seen", kind: "Fixed", title: "Shared links open for guests again", detail: "A guest opening a shared patch no longer lands on sign-in.", unseen: false })}${behindTheScenes(["Patchy now records how long each page takes to draw."])}`,
  stateTable("Change", [
    ["Seen", "kind and title on one line, closed"],
    ["New to you", "open, with the blue dot after its title"],
    ["From its permalink", "the fragment opens it, with script"],
    ["Behind the scenes", "a quiet line with no kind, the day's lines inside"]
  ])
);

const detailParts = demo(
  "Detail parts",
  `<div class="stack"><div class="cluster">${chipMenu({
    id: "g-outcome",
    key: "Outcome",
    value: "Any",
    choices: [
      { label: "Any", href: "#detail-parts", current: true },
      { label: "Failed", href: "#detail-parts" },
      { label: "Refused", href: "#detail-parts" }
    ]
  })}${chipMenu({
    id: "g-person",
    key: "Person",
    value: "Ada Lovelace",
    on: true,
    choices: [
      { label: "Anyone", href: "#detail-parts" },
      { label: "Ada Lovelace", href: "#detail-parts", current: true }
    ]
  })}${rowMenu("g-header", "New Business", [
    menuNewTab("https://example.com/acme/new-business", "New Business"),
    menuCopy("https://example.com/acme/new-business", "Copy link", "New Business"),
    menuRule,
    menuLink("#detail-parts", "Retire…", true, "New Business"),
    menuLink("#detail-parts", "Delete…", true, "New Business")
  ])}</div>${groupedTable({
    label: "Log",
    compact: true,
    columns: [
      { label: "Time" },
      { label: "Person" },
      { label: "Handler", hideOnPhone: true },
      { label: "Outcome" }
    ],
    groups: [
      {
        label: "Today",
        rows: [
          {
            id: "g-entry-failed",
            cells: [
              "14:02",
              person("ada@example.com", "Ada Lovelace"),
              "<code>deals.move</code>",
              badge("Failed", "danger")
            ],
            expand: {
              summary: "attio/crm refused the key",
              body: '<p class="meta">records.update · 401 · 312 ms</p>'
            }
          },
          {
            id: "g-entry-open",
            cells: [
              "13:40",
              person("grace@example.com", "Grace Hopper"),
              "<code>deals.list</code>",
              '<span class="muted">Succeeded</span>'
            ],
            expand: {
              summary: "1 call",
              body: '<p class="meta">records.query · 200 · 88 ms</p>',
              open: true
            }
          }
        ]
      },
      {
        label: "Yesterday",
        rows: [
          {
            cells: [
              "17:15",
              person("ada@example.com", "Ada Lovelace"),
              "<code>deals.add</code>",
              '<span class="muted">Succeeded</span>'
            ]
          }
        ]
      }
    ]
  })}${rows(
    [
      codeRow({
        name: "deals.list",
        description: "List open deals",
        end: '<span class="meta">Reads</span>'
      }),
      codeRow({
        name: "deals.move",
        description: "Move a deal to another stage",
        end: '<span class="meta">Changes</span>'
      })
    ],
    true
  )}${settingsPanel({
    cards: [
      card({
        rows: [
          settingRow({
            title: "Owner",
            description: "Ada Lovelace",
            control: button("Reassign…", { type: "button", size: "sm" })
          })
        ]
      })
    ],
    danger: card({
      title: "Take it down",
      danger: true,
      rows: [
        settingRow({
          title: "Retire",
          description: "Off its address until you restore it.",
          control: button("Retire…", { type: "button", size: "sm" })
        })
      ]
    })
  })}${rows([row({ name: "A refusal over a Detail page", href: link("refused"), description: "Takes the focus when the page opens" })], true)}</div>`,
  `${stateTable("Chip menu", [
    ["Any", "its key and value with a chevron; its menu lists each value as a link"],
    [
      "Chosen",
      "yellow with an ink edge while it narrows the list, the value marked current in its menu"
    ],
    ["Without script", "a native popover of links, so the URL holds the filter"]
  ])}${stateTable("Grouped table", [
    ["Collapsed", "each row's summary under it, closed"],
    ["Open", "what the row opens to, in a full-width cell under it"],
    ["From a permalink", "a fragment naming the row opens it, with script, and keeps it in view"],
    ["Phone", "cells stay on one line; the table scrolls in its own wrapper"]
  ])}${stateTable("Person and code row", [
    ["Person", "a small circle of initials beside the name, as owners and callers appear"],
    [
      "Code row",
      "a name typed exactly, in Geist Mono, its description beside it and what it does at its end"
    ]
  ])}${stateTable("Settings panel", [
    [
      "Rest",
      "the Settings template's cards at the settings width inside a tab, the danger zone last"
    ]
  ])}${stateTable("Refusal", [
    ["Focused", "a notice no field owns that takes the page's focus, so it is read first"],
    ["From the keyboard", "the ring goes round the notice it holds"],
    ["A field's own", "never this: the field's error under it, and the field takes the focus"]
  ])}`
);

const checklistDemo = demo(
  "Checklist",
  `<div class="stack">${checklist({
    id: "g-retire",
    legend: "Which to retire",
    name: "patch",
    items: [
      { value: "kudos", label: "Kudos", description: "Nothing else reads it", checked: true },
      {
        value: "spend",
        label: "Spend Requests",
        description: "Read by Timesheets (Grace Hopper)"
      },
      { value: "brief", label: "Kickoff brief", description: "Retired", disabled: true }
    ]
  })}${rows(
    [
      row({
        name: "Refused, with a box to choose",
        href: link("checklist-refused"),
        description: "Focus starts on its first box that can be chosen"
      }),
      row({
        name: "Refused, with none to choose",
        href: link("checklist-none"),
        description: "Focus starts on its error"
      })
    ],
    true
  )}</div>`,
  stateTable("Checklist", [
    ["Unchecked", "a row with its box, name and a line about it; a press on the row toggles it"],
    ["Checked", "the box filled in ink"],
    ["Not choosable", "the row kept but muted and its box disabled, such as a retired patch"],
    ["Set back", "the row muted but its box still choosable, such as a deactivated person"],
    [
      "Changed",
      "a box with a saved state says Adding or Removing beside its name while it differs from it, with or without script"
    ],
    [
      "Refused",
      "the error under the list, each box aria-invalid; focus starts on the first box that can be chosen, or on the error when none can"
    ],
    ["Hover (fine pointer)", "a faint tint on a row that can be chosen"]
  ])
);

const roster = demo(
  "List beside its entry and change bar",
  listDetail({
    id: "g-teams",
    label: "Teams",
    at: "entry",
    parent: { label: "Teams", href: "#g-teams" },
    entries: [
      { name: "Design", href: "#g-teams", description: "4 people · 1 patch" },
      {
        name: "Sales",
        href: "#g-teams",
        description: "3 people · 2 patches · attio/crm",
        current: true
      },
      { name: "Studio ops", href: "#g-teams", description: "2 people · Nothing yet" }
    ],
    title: "Sales",
    meta: ["3 people", "2 patches", "attio/crm"],
    actions: linkButton("Rename…", "#g-teams", { size: "sm" }),
    body: `<form class="stack" method="post" action="#g-teams">${searchField({ id: "g-find", inForm: true, query: "", placeholder: "Find people", label: "Find people" })}${checklist(
      {
        id: "g-roster",
        legend: "In Sales · 2",
        name: "keep",
        items: [
          {
            value: "ada",
            label: "Ada Lovelace",
            description: "ada@example.com · Admin",
            checked: true,
            saved: true
          },
          { value: "leo", label: "Leo Grant", description: "leo@example.com", saved: true },
          {
            value: "rowan",
            label: "Rowan Hale",
            description: "rowan@example.com · Deactivated",
            checked: true,
            saved: true,
            muted: true
          }
        ]
      }
    )}${checklist({
      id: "g-others",
      legend: "Everyone else · 1",
      name: "add",
      items: [
        { value: "kofi", label: "Kofi Mensah", description: "Design", checked: true, saved: false }
      ]
    })}${changeBar({ added: 1, removed: 1, offPage: { added: 0, removed: 0 }, actions: `${linkButton("Discard", "#g-teams", { kind: "quiet", size: "sm" })}${button("Review…", { kind: "primary", size: "sm", type: "button" })}` })}</form>`
  }),
  `${stateTable("List beside its entry", [
    ["Rest", "the list's rows on the left, the open entry under its own heading on the right"],
    ["Open", "the open entry's row filled, with an ink mark at its edge"],
    ["Phone", "each a screen of its own: the list, or the open entry under a link back to the list"]
  ])}${stateTable("Change bar", [
    [
      "Changed",
      "stuck to the bottom of its form, inked and lifted: Add 1, remove 1, then Discard and Review…"
    ],
    ["Unchanged, with script", "not there"],
    ["Without script", "always there, saying what the page was drawn with"]
  ])}`
);

const adaAsParty = {
  mark: avatar("ada@example.com", "Ada Lovelace"),
  name: "Ada Lovelace",
  meta: "ada@example.com"
};

const doorParts = demo(
  "Door parts",
  `<div class="stack">${verificationCode("WXYZ-1234")}${meet(
    { mark: agentMark, name: "Claude", meta: "claude.ai" },
    "wants to act as",
    adaAsParty
  )}${answerPair(button("Deny", { type: "button", block: true }), button("Allow", { type: "button", kind: "primary", block: true }))}${rows(
    [
      row({
        name: "Device login",
        href: link("door"),
        description: "A code to compare, the computer's name, Confirm or Deny"
      }),
      row({
        name: "Consent",
        href: link("consent"),
        description: "Who meets whom, what it can and can't do, Deny or Allow"
      }),
      row({
        name: "Refused, no field",
        href: link("door-refused"),
        description: "The account changed while it was open; the notice takes the focus"
      }),
      row({
        name: "Refused, a field",
        href: link("door-field"),
        description: "The computer's name refused; the field takes the focus"
      }),
      row({
        name: "Outcome",
        href: link("door-outcome"),
        description: "Confirmed: go back to the terminal"
      }),
      row({ name: "Unavailable", href: link("door-unavailable"), description: "Try again" })
    ],
    true
  )}</div>`,
  `${stateTable("Door", [
    [
      "Rest",
      "one card on the grid-and-gradient canvas: the brand, a kicker, a title, the body, one primary and a quiet secondary, and a foot such as Not you?"
    ],
    [
      "Outcome",
      "each ending its own door in the same card, such as confirmed, denied, expired or already used"
    ],
    [
      "Refused, no field",
      "a notice at the top of the body that takes the focus, such as the account changing while it was open"
    ],
    ["Refused, a field", "the field's error under it, and the field takes the focus"],
    ["Unavailable", "the same card saying to try again soon, never the app's navigation"],
    ["Phone", "the card closer to the edges, with less padding"]
  ])}${stateTable("Verification code", [
    ["Rest", "tabular mono at a title's size, the separator kept, so it matches as one string"],
    ["Narrow", "its letters closer together below 380px"]
  ])}${stateTable("Meet", [
    ["Rest", "the app's mark and name, an arrow, then the person's, each with one line under it"],
    ["Readers", "the arrow says what it means, such as wants to act as"]
  ])}${stateTable("Answer pair", [
    ["Rest", "two answers of equal width side by side; the one to take is primary"]
  ])}`
);

const templatesSection = section({
  title: "Five templates",
  body: rows(
    (
      [
        ["Index", "index", "Home, All patches, People, Integrations, Your agents, What's new"],
        ["Detail", "detail", "A patch, a connection"],
        ["Detail with a refusal", "refused", "A stale or refused act, read first"],
        ["Settings", "settings", "Agent access, a patch's Settings, a connection's Settings"],
        ["Flow", "flow", "Connect an integration, connect an app, add a computer"],
        ["Door", "door", "Sign in, join, device login, notices"],
        ["Consent", "consent", "An app asking to use patches as the person"],
        ["Dialog", "dialog", "Share, Invite, New patch, Delete, over their page"],
        ["Dialog only its actions close", "final", "The Final step"]
      ] satisfies ReadonlyArray<readonly [string, GalleryPage, string]>
    ).map(([name, page, description]) => row({ name, href: link(page), description })),
    true
  )
});

const isLogo = (name: string): name is ProductLogo => Object.hasOwn(productLogos, name);
/** Every logo Patchy knows, at each size a product mark takes. */
const logoMarks = [{ large: true }, {}].map(
  (size) =>
    `<div class="cluster">${Object.keys(productLogos)
      .filter(isLogo)
      .map((logo) => productMark({ logo }, size))
      .join("")}</div>`
);

const flowParts = demo(
  "Choice links, a flow's outcome, product and computer marks",
  `<div class="stack">${choiceLinks({
    label: "App",
    current: "Claude",
    items: [
      { label: "Claude", href: "#choices", mark: productMark({ logo: "claude" }) },
      { label: "Codex", href: "#choices", mark: productMark({ logo: "openai" }) },
      {
        label: "Another agent",
        href: "#choices",
        mark: productMark("+", { dashed: true }),
        dashed: true
      }
    ]
  })}${flowOutcome({
    title: "Once connected",
    body: canList([
      { can: true, text: "Claude uses the agent tools in patches you can open, as you" },
      { can: true, text: "Every change it makes is logged under your name, via Claude" },
      { can: false, text: "It can’t publish or change a patch’s code" }
    ])
  })}${logoMarks.join("")}<div class="cluster">${productMark({ icon: "mail" }, { large: true })}${productMark({ icon: "mail" })}${productMark("Z", { large: true })}${productMark("Z")}${productMark("+", { dashed: true })}${computerMark}</div></div>`,
  `${stateTable("Choice link", [
    ["Rest", "a tile on a strong edge: the choice's mark and name, a link to its own URL"],
    ["Current", "a 2px ink edge on the chosen fill, marked as the current page"],
    ["Hover (fine pointer)", "an ink edge"],
    ["Dashed", "one standing in for any other, muted until chosen"]
  ])}${stateTable("Can list", [
    ["Can", "under a check, each sentence saying what it can"],
    ["Can't", "under a cross, each sentence saying what it can't"]
  ])}${stateTable("Flow outcome", [
    ["Rest", "a section title and what it holds, on the flow's own gap after the numbered sections"]
  ])}${stateTable("Product mark", [
    ["Logo", "a product Patchy knows, in its own logo and colours on a white square"],
    ["Icon", "a kind of product rather than one, such as email's envelope"],
    ["Letters", "any other product's letters on the same square"],
    ["Rest", "flat in a list"],
    ["Hero", "inked and lifted beside a page title"],
    ["Dashed", "one that isn't listed"],
    [
      "Forced colours",
      "a logo keeps its white square and its colours, as an image does; icons and letters take the theme's"
    ]
  ])}${stateTable("Computer mark", [["Rest", "a laptop on the same white square, flat in a list"]])}`
);

const system = indexPage({
  title: "The system",
  meta: ["Every first-party page composes these parts and one of five templates"],
  content: `${templatesSection}${type}${colours}${buttons}${fields}${choices}${checklistDemo}${status}${feedback}${navigation}${lists}${wideParts}${homeParts}${detailParts}${headers}${cards}${roster}${disclosures}${changes}${marks}${setupSteps}${flowParts}${doorParts}<script defer src="${copyScriptPath}"></script>`
});

const sampleRows = ["kudos", "new-business", "spend"].map((name) => [
  `<div class="cell-name">${patch(name)}<div class="row-main"><a class="row-link" href="${link("detail")}">${escapeHtml(name)}</a><span class="row-desc">A tool at Acme Co</span></div></div>`,
  "Ada Lovelace",
  "None",
  menu({
    id: `g-${name}`,
    label: name,
    items: [{ kind: "link", label: "Open", href: link("detail") }]
  })
]);

const indexDemo = indexPage({
  title: "All patches",
  meta: ["3 patches"],
  actions: linkButton("New patch", link("dialog"), { kind: "primary", icon: "plus" }),
  toolbar: segmented({
    label: "Show",
    current: "All",
    items: [
      { label: "All", href: link("index"), count: 3 },
      { label: "Tools", href: link("index"), count: 3 },
      { label: "Yours", href: link("index"), count: 3 }
    ]
  }),
  content: table({
    label: "Patches",
    columns: [
      { label: "Patch" },
      { label: "Owner", hideOnPhone: true },
      { label: "Failures today" },
      { label: "Actions", hidden: true }
    ],
    rows: sampleRows
  })
});

const detailSpec = {
  parent: { label: "All patches", href: link("index") },
  mark: patchMark("new-business", 2, true),
  title: "New Business",
  meta: ["Tool", "<code>acme/new-business</code>"],
  actions: `${button("Share", { type: "button", icon: "share" })}${linkButton("Open", link("detail"), { kind: "primary", icon: "external" })}`,
  tabs: tabs({
    label: "New Business",
    current: "Overview",
    items: [
      { label: "Overview", href: link("detail") },
      { label: "Log", href: link("detail") },
      { label: "Versions", href: link("detail"), count: 3 },
      { label: "Settings", href: link("settings") }
    ]
  }),
  main: `<p class="prose">Every pitch from first lead to signed work, with owners and stage rules.</p>${facts(
    [
      ["Owner", "Ada Lovelace"],
      ["Version", "v3"],
      ["Opens", "128"]
    ]
  )}`,
  aside: `<div class="box box-pad"><h2 class="section-title">Your agent can, as you</h2><p class="meta">List deals, add leads, move deals.</p></div>`
} satisfies Parameters<typeof detailPage>[0];

const detailDemo = detailPage(detailSpec);

/** The Detail page with an act refused, such as Retire from a tab left open: the refusal leads. */
const refusedDemo = detailPage({
  ...detailSpec,
  main: `${refusalNotice("New Business was retired in another tab. Nothing was done.")}${detailSpec.main}`
});

const settingsDemo = settingsPage({
  parent: { label: "New Business", href: link("detail") },
  title: "Settings",
  cards: [
    card({
      body: field({
        id: "g-s-desc",
        label: "Description",
        control: (aria) =>
          textarea(aria, {
            name: "description",
            value: "Every pitch from first lead to signed work."
          })
      }),
      foot: `<span class="meta">Up to 500 characters</span>${button("Save", { kind: "primary", size: "sm" })}`,
      form: { action: link("settings") }
    }),
    card({
      rows: [
        settingRow({
          title: "Owner",
          description: "Can publish, change and take it down.",
          control: button("Reassign…", { type: "button", size: "sm" })
        }),
        settingRow({
          title: "Agents use patches",
          description: "People's own agents can use the agent tools in patches.",
          control: switchForm({
            action: link("settings"),
            label: "Agents use patches",
            checked: true
          })
        })
      ]
    })
  ],
  danger: card({
    title: "Take it down",
    danger: true,
    rows: [
      settingRow({
        title: "Retire",
        description: "Off its address until you restore it.",
        control: button("Retire…", { type: "button", size: "sm" })
      }),
      settingRow({
        title: "Delete",
        description: "Gone for good 30 days later, unless restored.",
        control: button("Delete…", { type: "button", size: "sm", kind: "danger" })
      })
    ]
  })
});

const flowDemo = flowPage({
  parent: { label: "Integrations", href: link("index") },
  title: "Connect Attio",
  sections: [
    {
      title: "Get it",
      body: '<p class="prose">In Attio, open Workspace settings › Developers and create a read-only key.</p>'
    },
    {
      title: "Paste it",
      body: field({
        id: "g-f-key",
        label: "Access token",
        control: (aria) => secretInput(aria, { name: "key", autocomplete: "off" })
      })
    },
    {
      title: "Choose a workspace",
      locked: true,
      body: choiceGroup({
        id: "g-f-workspace",
        legend: "Workspace",
        hint: "Its workspaces appear once Patchy has checked the key.",
        choices: radio({ name: "workspace", value: "acme", label: "Acme Co" })
      })
    },
    {
      title: "Name it",
      body: field({
        id: "g-f-name",
        label: "Name",
        hint: ["Patches use it as attio/", { value: "", fallback: "crm" }, "."],
        control: (aria) => prefixInput(aria, { name: "handle", prefix: "attio/", exact: true })
      })
    }
  ],
  outcome: notice({
    tone: "info",
    title: "Once connected",
    body: "<p>Patches that declare it can read records and lists. Nothing changes in Attio.</p>"
  }),
  submit: `${button("Test and connect", { kind: "primary", pendingLabel: "Testing…" })}${linkButton("Cancel", link(""), { kind: "quiet" })}`,
  form: { action: link("flow") }
});

/** Device login's door; `refused` draws it again as a refusal no field owns, or the name's. */
const deviceDoor = (refused?: "account" | "name") =>
  doorPage({
    kicker: "Device login",
    title: "Is this the code in your terminal?",
    body: `${refused === "account" ? refusal(notice({ tone: "warning", title: "The signed-in account changed since this page loaded.", body: "<p>Check the account and the code, then press again.</p>" })) : ""}${verificationCode("WXYZ-1234")}<p>A terminal ran <code>patchy login</code> and wants to publish at <span class="strong">Acme Co</span> as <span class="strong">Ada Lovelace</span>. If you didn’t run it, deny: nothing happens.</p><form id="g-device" method="post" action="${link("door")}" novalidate>${field(
      {
        id: "g-door-name",
        label: "Name this computer",
        hint: "You’ll see it on Your agents.",
        ...(refused === "name" ? { error: "Give the computer a name, up to 64 characters." } : {}),
        control: (aria) =>
          input(aria, {
            name: "name",
            value: refused === "name" ? "" : "Ada’s MacBook",
            maxlength: 64,
            autofocus: refused === "name"
          })
      }
    )}</form>`,
    actions: `${button("Confirm", { kind: "primary", block: true, form: "g-device" })}${button("Deny", { kind: "quiet", block: true, form: "g-device" })}`,
    foot: "Signed in as ada@example.com · Not you?"
  });

const outcomeDoor = doorPage({
  kicker: "Device login",
  title: "Go back to your terminal",
  body: '<p>Your agent finishes connecting <span class="strong">Ada’s MacBook</span>. It shows up on Your agents as soon as it does.</p>',
  actions: linkButton("Open Your agents", link(""), { block: true }),
  foot: "You can close this tab."
});

const unavailableDoorDemo = doorPage({
  title: "Patchy is unavailable",
  body: "<p>Please try again.</p>"
});

/** A deactivation refused for its checklist: with a box still to choose, or with none. */
const refusedChecklist = (choosable: boolean) =>
  flowPage({
    parent: { label: "People", href: link("index") },
    title: "Deactivate Grace Hopper",
    sections: [
      {
        title: "Their patches",
        body: checklist({
          id: "g-pick",
          legend: "Which to retire",
          name: "patch",
          error: choosable
            ? "Select at least one, or keep their patches live."
            : "None of their patches can be retired now.",
          items: [
            ...(choosable
              ? [{ value: "kudos", label: "Kudos", description: "Nothing else reads it" }]
              : []),
            { value: "brief", label: "Kickoff brief", description: "Retired", disabled: true },
            { value: "old", label: "Old intake form", description: "Deleted", disabled: true }
          ]
        })
      }
    ],
    submit: `${button("Deactivate Grace Hopper", { kind: "danger-solid" })}${linkButton("Cancel", galleryPath, { kind: "quiet" })}`,
    form: { action: link(choosable ? "checklist-refused" : "checklist-none") }
  });

const consentDemo = doorPage({
  kicker: "Agent access",
  title: "Let Claude use Acme Co’s patches as you?",
  body: `${meet({ mark: agentMark, name: "Claude", meta: "claude.ai" }, "wants to act as", adaAsParty)}${canList(
    [
      {
        can: true,
        text: "It can find the patches you can open and use the agent tools their builders added, as you"
      },
      { can: true, text: "Every change it makes is logged as Ada Lovelace via Claude" },
      { can: false, text: "It can’t do anything you can’t, or publish" }
    ]
  )}`,
  actions: `${answerPair(button("Deny", { type: "button", block: true }), button("Allow", { type: "button", kind: "primary", block: true }))}<p class="meta">Your answer goes back to <strong>claude.ai</strong>.</p>`,
  foot: "Signed in as ada@example.com · Use another account"
});

/** The page at `page` and, for the dialog page, the dialog over it. */
export const galleryPage = (
  page: GalleryPage,
  /** The dialog page as a refused submission draws it again. */
  refused = false
): Template & { readonly title: string; readonly overlay?: string; readonly door?: true } => {
  switch (page) {
    case "":
      return { title: "The system", ...system };
    case "index":
      return { title: "Index", ...indexDemo };
    case "detail":
      return { title: "Detail", ...detailDemo };
    case "refused":
      return { title: "Detail with a refusal", ...refusedDemo };
    case "settings":
      return { title: "Settings", ...settingsDemo };
    case "flow":
      return { title: "Flow", ...flowDemo };
    case "checklist-refused":
      return { title: "Checklist refused", ...refusedChecklist(true) };
    case "checklist-none":
      return { title: "Checklist refused, none to choose", ...refusedChecklist(false) };
    case "door":
      return { title: "Door", door: true, ...deviceDoor() };
    case "door-refused":
      return { title: "Door refused", door: true, ...deviceDoor("account") };
    case "door-field":
      return { title: "Door with a refused field", door: true, ...deviceDoor("name") };
    case "door-outcome":
      return { title: "Door outcome", door: true, ...outcomeDoor };
    case "door-unavailable":
      return { title: "Door unavailable", door: true, ...unavailableDoorDemo };
    case "consent":
      return { title: "Consent", door: true, ...consentDemo };
    case "final":
      return {
        title: "Final step",
        ...system,
        overlay: dialog({
          id: "g-final",
          title: "Final step",
          body: `<p class="prose">Connect your agent. It builds what Acme Co needs, and Patchy puts it online.</p>${copyLine("Set up Patchy using https://example.com/llms.txt", "Setup line", "the setup line")}`,
          foot: linkButton("Later", galleryPath, { kind: "quiet" })
        })
      };
    case "dialog":
      return {
        title: "Invite people",
        ...system,
        overlay: dialog({
          id: "g-dialog",
          title: "Invite people",
          closeHref: galleryPath,
          form: { action: link("dialog") },
          body: `${field({ id: "g-d-emails", label: "Emails", hint: "One per line.", ...(refused ? { error: "Add at least one email address." } : {}), control: (aria) => textarea(aria, { name: "emails", grow: true, autofocus: true }) })}${choiceGroup({ id: "g-d-role", legend: "Role", choices: `${radio({ name: "role", value: "member", label: "Member", checked: true })}${radio({ name: "role", value: "admin", label: "Admin" })}` })}`,
          foot: `${linkButton("Cancel", galleryPath, { kind: "quiet" })}${button("Send invites", { kind: "primary" })}`
        })
      };
  }
};
