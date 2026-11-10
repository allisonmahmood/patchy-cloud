import {
  button,
  canList,
  escapeHtml,
  expandingTable,
  field,
  flowPage,
  input,
  linkButton,
  notice as noticeBox,
  prefixInput,
  productMark,
  section,
  type Template
} from "@patchy/core";
import * as View from "./ConnectionsView.js";
import * as Fields from "./Fields.js";

/**
 * Every integration's connect page: one Flow frame drawn from what the integration says, so
 * connecting Postgres, PostHog, Attio, Pidgeon or IMAP differs in words and fields, never layout.
 * The frame owns the order, the Name section, the access list, the actions and where refusals
 * read; an integration supplies only the slots of its `ConnectSpec`.
 *
 * In task order: 1 Get it, what to make in the other system first, never marked done; 2 Paste
 * it, the credential's fields at answer width, secrets masked; then any sections a check unlocks
 * (Pidgeon's address and what patches may do); Name it, the fused `kind/` prefix; Once connected,
 * what it can and can't do and at most one caveat; Test and connect and Cancel.
 */

/** What an integration says to be connected; the frame draws all of it. */
export interface ConnectSpec {
  /** What to make in the other system first. Nothing marks it done: Patchy can't see it happen. */
  readonly getIt: {
    readonly title: string;
    /** A sentence or two each, as plain text. */
    readonly steps: ReadonlyArray<string>;
    /** What to set, such as a key's scopes, as a two-column table. */
    readonly table?: {
      readonly head: readonly [string, string];
      readonly rows: ReadonlyArray<readonly [string, string]>;
    };
    /** What it needs, one requirement a line. */
    readonly list?: ReadonlyArray<string>;
    /** One line after the table or list. */
    readonly note?: string;
  };
  /** Where the credential goes: its section title and fields. */
  readonly paste: {
    readonly title: string;
    /** In order; a nested list shares a row, such as a server and its port. */
    readonly fields: Fields.Layout;
    /** Trusted HTML after the fields, such as Pidgeon's Find addresses. */
    readonly after?: (submitted: Fields.Submitted, refusal?: View.Notice) => string;
  };
  /**
   * Sections a check of the credential unlocks, between pasting and naming: Pidgeon's address and
   * what patches may do. Drawn locked; the integration's script unlocks them.
   */
  readonly choose?: (
    submitted: Fields.Submitted,
    refusal?: View.Notice
  ) => ReadonlyArray<{ readonly title: string; readonly body: string }>;
  /** Name it: an example handle and what a description might say. */
  readonly name: { readonly example: string; readonly describe: string };
  /**
   * Once connected: what patches read through it, whether builders' agents read it live while
   * they build, anything more it can do, what it never does, and at most one caveat. The frame
   * writes the platform's own facts around these, the same for every integration.
   */
  readonly once: {
    /** "this database, as the role you gave". */
    readonly reads: string;
    /** Its dev binding reads the real connection, rather than fixtures. */
    readonly devReads: boolean;
    readonly also?: ReadonlyArray<string>;
    readonly cannot: ReadonlyArray<string>;
    readonly caveat?: string;
  };
  /**
   * For an integration whose connecting runs in the page, as Pidgeon's discovery does: hidden
   * fields and its script's settings inside the form, the script, and what the page says without it.
   */
  readonly script?: {
    readonly fields: (submitted: Fields.Submitted) => string;
    readonly src: string;
    readonly without: string;
  };
}

/** The frame's one submit, which says "Testing…" while Patchy tests the credential. */
const testAndConnect = button("Test and connect", { kind: "primary", pendingLabel: "Testing…" });

/** The form fields a refusal can sit at on a connect page, by its spec. */
export const shows = (spec: ConnectSpec): ReadonlyArray<View.Field> => [
  ...Fields.flat(spec.paste.fields).map((item) => item.field),
  ...(spec.choose === undefined ? [] : (["address", "access"] as const)),
  "handle",
  "description"
];

/** 1 Get it: the steps in the other system, then what to set or have. */
const getIt = (spec: ConnectSpec["getIt"]) =>
  `${spec.steps.map((text) => `<p class="prose">${escapeHtml(text)}</p>`).join("")}${
    spec.table === undefined
      ? ""
      : expandingTable({
          label: spec.title,
          compact: true,
          columns: [{ label: spec.table.head[0] }, { label: spec.table.head[1] }],
          rows: spec.table.rows.map(([key, value]) => ({
            cells: [escapeHtml(key), escapeHtml(value)]
          }))
        })
  }${
    spec.list === undefined
      ? ""
      : `<ul class="prose">${spec.list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
  }${spec.note === undefined ? "" : `<p class="meta">${escapeHtml(spec.note)}</p>`}`;

/** Name it: the handle behind its fixed prefix, then the optional description. */
const nameIt = (
  integration: View.Integration,
  spec: ConnectSpec["name"],
  submitted: Fields.Submitted,
  refusal: View.Notice | undefined,
  /** Whether a refused field here can take focus: not while the section waits locked. */
  focus: boolean
) => {
  const handleError = Fields.errorAt("handle", refusal);
  const descriptionError = Fields.errorAt("description", refusal);
  return `${field({
    id: "connection-handle",
    label: "Name",
    hint: [
      `Patches use it as ${integration.key}/`,
      { value: submitted.handle ?? "", fallback: spec.example },
      ". Lowercase letters, digits and hyphens; it can't change later."
    ],
    ...(handleError === undefined ? {} : { error: handleError }),
    control: (aria) =>
      prefixInput(aria, {
        name: "handle",
        prefix: `${integration.key}/`,
        value: submitted.handle ?? "",
        required: true,
        maxlength: 32,
        pattern: "[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]",
        autocomplete: "off",
        width: "md",
        autofocus: focus && handleError !== undefined
      })
  })}${field({
    id: "connection-description",
    label: "Description",
    optional: true,
    hint: "Builders choose by it.",
    ...(descriptionError === undefined ? {} : { error: descriptionError }),
    control: (aria) =>
      input(aria, {
        name: "description",
        value: submitted.description ?? "",
        maxlength: 500,
        placeholder: spec.describe,
        autofocus: focus && descriptionError !== undefined
      })
  })}`;
};

/**
 * `/settings/integrations/connect/:integration`: the integration's connect page in the shared
 * frame. A refused submit keeps everything typed except secrets; a refusal about a field reads
 * under it, any other right above Test and connect, in focus. Cancel goes `back` to where the
 * integration was chosen.
 */
export const render = (input: {
  readonly integration: View.Integration;
  readonly spec: ConnectSpec;
  readonly submitted: Fields.Submitted;
  readonly notice?: View.Notice;
  readonly back: string;
}): Template => {
  const { integration, spec, submitted, notice } = input;
  // A refusal about a part a check unlocks, Pidgeon's address, access or name, keeps its place at
  // its field, but that part is locked again until the key is checked, so a summary above the
  // actions takes focus and says how to get back; the page's script clears it once the key is in.
  const locked =
    spec.choose === undefined ? [] : (["address", "access", "handle", "description"] as const);
  const relock =
    notice?.field !== undefined && locked.some((field) => field === notice.field)
      ? `<div tabindex="-1" autofocus data-relock>${View.feedback({
          ...notice,
          field: undefined,
          message: `${notice.message} Paste the admin key again and find addresses: your other choices are kept.`
        })}</div>`
      : "";
  const refusal =
    notice === undefined
      ? ""
      : notice.field === undefined
        ? Fields.focused(View.feedback(notice))
        : relock;
  const once = section({
    title: "Once connected",
    body: `${canList([
      { can: true, text: `Every member reads ${spec.once.reads} through patches that use it` },
      ...(spec.once.devReads
        ? [{ can: true, text: "Builders' agents read it while they build, as themselves" }]
        : []),
      { can: true, text: "Guests of those patches too, unless you block guests" },
      ...(spec.once.also ?? []).map((text) => ({ can: true, text })),
      ...spec.once.cannot.map((text) => ({ can: false, text }))
    ])}${spec.once.caveat === undefined ? "" : `<p class="meta">${escapeHtml(spec.once.caveat)}</p>`}`
  });
  const choose = spec.choose?.(submitted, notice) ?? [];
  return flowPage({
    parent: {
      label: input.back === View.indexPath ? "Integrations" : "Connect an integration",
      href: input.back
    },
    mark: productMark(integration.mark, { large: true }),
    title: `Connect ${integration.label}`,
    form: {
      action: View.connectPath(integration.key),
      ...(spec.script === undefined ? {} : { fields: spec.script.fields(submitted) })
    },
    sections: [
      { title: spec.getIt.title, body: getIt(spec.getIt) },
      {
        title: spec.paste.title,
        body: `${Fields.renderAll(spec.paste.fields, submitted, notice)}${spec.paste.after?.(submitted, notice) ?? ""}`
      },
      ...choose.map((part) => ({ ...part, locked: true })),
      {
        title: "Name it",
        body: nameIt(integration, spec.name, submitted, notice, choose.length === 0),
        locked: choose.length > 0
      }
    ],
    outcome: `${once}${refusal}${
      spec.script === undefined
        ? ""
        : `<noscript>${noticeBox({ tone: "warning", title: "This page needs JavaScript", body: `<p>${escapeHtml(spec.script.without)}</p>` })}</noscript><script defer src="${spec.script.src}"></script>`
    }`,
    // Where a check unlocks parts of the form, Test and connect waits with them: the page's
    // script opens it once the form is ready, and without script it stays shut.
    submit: `${
      choose.length === 0
        ? testAndConnect
        : `<fieldset class="fieldset" disabled data-ready-gate>${testAndConnect}</fieldset>`
    }${linkButton("Cancel", input.back, { kind: "quiet" })}`
  });
};
