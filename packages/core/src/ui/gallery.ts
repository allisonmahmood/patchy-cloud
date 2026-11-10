import { agentMark, avatar, choiceCards, patchMark, tileOptions } from "../components.js";
import { copyLine, copyScriptPath } from "../copy-line.js";
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
import { badge, dot, emptyState, notice, receipt } from "./feedback.js";
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

/**
 * The `/~ui` gallery, development only: every helper in each state it has, a state table per
 * component, and one page per template drawn from sample data. It is what a page should look like
 * when it composes the system, and where a change to the system is seen first.
 */
export const galleryPath = "/~ui";

/** The gallery's pages: the system, each template, and a dialog over the system. */
export const galleryPages = [
  "",
  "index",
  "detail",
  "settings",
  "flow",
  "door",
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

const type = demo(
  "Type",
  table({
    label: "Type roles",
    columns: [{ label: "Role" }, { label: "Sample" }],
    rows: (
      [
        ["Page title · 28/34 · 800", '<span class="title">New Business</span>'],
        ["Dialog and door title · 22/28 · 800", '<span class="title-sm">Invite people</span>'],
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

/** The token block's colours, drawn from its own values so the gallery never disagrees with it. */
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
  })
);

const buttons = demo(
  "Buttons",
  `<div class="stack"><div class="btn-group">${linkButton("Open", "#buttons", { kind: "primary", icon: "external" })}${button("Share", { type: "button", icon: "share" })}${button("Cancel", { type: "button", kind: "quiet" })}${button("Delete…", { type: "button", kind: "danger", icon: "trash" })}${button("Delete New Business", { type: "button", kind: "danger-solid" })}</div><div class="btn-group">${button("Save", { type: "button", kind: "primary", size: "sm" })}${button("Reassign…", { type: "button", size: "sm" })}${iconButton("More", "more")}${iconButton("Copy", "copy")}${button("Testing…", { type: "button", kind: "primary", pending: true })}</div></div>`,
  stateTable("Button", [
    ["Rest", "2px ink edge; primary is blue with a 2px hard shadow"],
    ["Hover (fine pointer)", "lifts 1px into a deeper shadow; quiet and icon buttons tint instead"],
    ["Pressed", "sinks into its shadow"],
    ["Focus", "2px ink ring, 2px out"],
    ["Pending", "the pressed label, such as Testing…, static, aria-disabled"],
    ["Touch", "44px tall"]
  ])
);

const fields = demo(
  "Fields",
  `<div class="fields">${field({ id: "g-name", label: "Name", control: (aria) => input(aria, { name: "name", value: "Brightline Studio" }) })}${field({ id: "g-desc", label: "Description", hint: "One line on what this database is for.", optional: true, control: (aria) => input(aria, { name: "description" }) })}${field({ id: "g-handle", label: "Name", hint: "Patches use this name, which can't be changed later.", error: "Lowercase letters, digits and hyphens only.", control: (aria) => prefixInput(aria, { name: "handle", prefix: "attio/", value: "CRM Main" }) })}${field({ id: "g-key", label: "Access token", control: (aria) => secretInput(aria, { name: "key", value: "secret-sample-value", autocomplete: "off" }) })}${field(
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
  )}${choiceGroup({ id: "g-plan", legend: "Plan", error: "Pick a plan.", choices: (aria) => `${radio({ name: "plan", value: "team", label: "Team", aria })}${radio({ name: "plan", value: "company", label: "Company", aria })}` })}${field({ id: "g-note", label: "Emails", hint: "One per line.", control: (aria) => textarea(aria, { name: "emails", grow: true }) })}${choiceGroup({ id: "g-access", legend: "Who can open it", choices: `${radio({ name: "access", value: "company", label: "People at Acme Co", checked: true })}${radio({ name: "access", value: "public", label: "Anyone on the internet" })}${checkbox({ name: "remember", value: "1", label: "Remember this computer", checked: true })}` })}${choiceGroup(
    {
      id: "g-mode",
      legend: "Patches may",
      choices: choiceCards("g-mode", [
        { value: "read", title: "Read", points: ["Its mail and labels", "Nothing changes"] },
        { value: "send", title: "Read and send", points: ["Also reply and send"], checked: true }
      ])
    }
  )}<div class="fieldset"><span class="field-label">Copy line</span>${copyLine("patchy add attio/crm", "Command", "the command")}</div></div>`,
  `${stateTable("Field", [
    ["Rest", "1px ink edge at button height, surface fill"],
    ["Focus", "2px ink ring outside and a 1px ink edge inside"],
    ["Refused", "danger edge, aria-invalid, the error under it, linked by aria-describedby"],
    ["Prefix", "the fixed part fused before the input, a label that focuses it"],
    ["Secret", "masked; Show appears with script and toggles the mask"],
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
  `<div class="stack"><div class="cluster"><span class="muted">None</span><span class="muted">No calls yet</span>${badge("2 failed", "danger")}</div><div class="cluster"><span class="muted">Succeeded</span>${badge("Failed", "danger")}${badge("Refused", "warning")}${badge("Running", "info")}${badge("Unknown")}</div><div class="cluster">${dot("Connected", "success")}${badge("Needs attention", "danger")}${badge("Paused")}${badge("Serving", "yellow")}</div><div class="cluster">${badge("Invited")}${badge("Guest")}<span class="you">(you)</span>${badge("Expires soon", "warning")}<span class="unseen" aria-label="New to you"></span></div></div>`,
  stateTable("Status", [
    [
      "Quiet",
      "plain text or a dot with its word, for routine states such as Succeeded or Connected"
    ],
    ["Needs a decision", "a badge on its tone: danger, warning, info"],
    ["Plain badge", "a state to note, such as Paused or Invited"],
    ["New to you", "a blue dot named for readers"]
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
    ["Linked row", "the first cell's link covers the row"]
  ])}${stateTable("Menu", [
    ["Closed", "a quiet ⋯ button named for its row"],
    [
      "Open",
      "a native popover with an ink edge and a hard shadow, under its button where the browser anchors it"
    ],
    ["Item", "a link, or a button in its own form; danger items in red"],
    ["Escape", "closes it and focus returns to its button"]
  ])}${stateTable("Facts", [
    ["Rest", "muted labels beside values, one pair a line"],
    ["Phone", "each label above its value"]
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
  '<details><summary>Don\'t have an agent yet?</summary><p class="prose" id="g-disclosure-answer">Claude Code, Codex or Cursor each run on your computer and can build patches.</p></details>',
  stateTable("Disclosure", [
    ["Closed", "the summary, with the browser's marker"],
    ["Open", "its content under the summary"],
    ["From a link", "a fragment naming something inside opens it, with script"]
  ])
);

const templatesSection = section({
  title: "Five templates",
  body: rows(
    (
      [
        ["Index", "index", "Home, All patches, People, Integrations, Your agents, What's new"],
        ["Detail", "detail", "A patch, a connection"],
        ["Settings", "settings", "Agent access, a patch's Settings, a connection's Settings"],
        ["Flow", "flow", "Connect an integration, connect an app, add a computer"],
        ["Door", "door", "Sign in, join, device login, consent, notices"],
        ["Dialog", "dialog", "Share, Invite, New patch, Delete, over their page"],
        ["Dialog only its actions close", "final", "The Final step"]
      ] satisfies ReadonlyArray<readonly [string, GalleryPage, string]>
    ).map(([name, page, description]) => row({ name, href: link(page), description })),
    true
  )
});

const system = indexPage({
  title: "The system",
  meta: ["Every first-party page composes these parts and one of five templates"],
  content: `${templatesSection}${type}${colours}${buttons}${fields}${choices}${status}${feedback}${navigation}${lists}${headers}${cards}${disclosures}${marks}${setupSteps}<script defer src="${copyScriptPath}"></script>`
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

const detailDemo = detailPage({
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
        hint: "Patches use this name.",
        control: (aria) => prefixInput(aria, { name: "handle", prefix: "attio/", value: "crm" })
      })
    }
  ],
  outcome: notice({
    tone: "info",
    title: "Once connected",
    body: "<p>Patches that declare it can read records and lists. Nothing changes in Attio.</p>"
  }),
  submit: `${button("Test and connect", { kind: "primary" })}${linkButton("Cancel", link(""), { kind: "quiet" })}`,
  form: { action: link("flow") }
});

const doorDemo = doorPage({
  kicker: "Device login",
  title: "Is this your computer?",
  body: `<p>Check this code matches the one your agent shows.</p><p class="verification-code">WXYZ-1234</p>`,
  actions: `${button("Confirm", { kind: "primary" })}${button("Deny", { kind: "quiet" })}`,
  foot: "Signed in as ada@example.com"
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
    case "settings":
      return { title: "Settings", ...settingsDemo };
    case "flow":
      return { title: "Flow", ...flowDemo };
    case "door":
      return { title: "Door", door: true, ...doorDemo };
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
