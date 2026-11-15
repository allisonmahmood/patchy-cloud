import type { PidgeonSnapshot } from "@patchy/api";
import {
  button,
  choiceCards,
  choiceGroup,
  escapeAttribute,
  escapeHtml,
  monogram,
  tileOptions,
  type TileOption
} from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";
import * as Keys from "./Keys.js";

/**
 * What the connections pages say about Pidgeon, and its connect page. The key is typed into the
 * page and travels only in the bodies of the admin's own requests; nothing here ever writes it
 * back, so a refused submit asks for it again.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Every sentence the Pidgeon pages say, one place each, so wording changes in one spot. What the
 * page's script says in the browser is here too, handed to it through its settings.
 */
export const copy = {
  label: "Pidgeon email",
  offer: "Read and send from one inbox",
  logged:
    "Each call keeps its operation and the ids it named, and a send its subject and recipients; message bodies and search text are never logged.",
  getIt: {
    title: "Make a key in Pidgeon",
    step: "In Pidgeon's dashboard, open API keys and make a new key named Patchy: Send if patches will reply and send, or Read if they only read. Choose Test as its mode to try Patchy without sending real mail."
  },
  key: {
    title: "Paste the key",
    label: "Pidgeon key",
    hint: "A Pidgeon key reaches your whole Pidgeon account. Patchy keeps it encrypted, and patches reach only the inbox you choose.",
    missing: "Paste a Pidgeon key: it starts with pgn_.",
    find: "Find inboxes",
    checking: "Checking…",
    unchecked: "Patchy couldn't check the key. Try again.",
    unreached: "Patchy couldn't reach the instance. Try again."
  },
  /** The key's status line once Patchy has listed what it reaches. */
  status: (found: { readonly test: boolean; readonly level: Keys.Level; readonly count: number }) =>
    `${found.test ? "Test key" : "Live key"} · ${found.level === "read" ? "reads only" : found.level === "send" ? "reads and sends" : "admin, though a Send key is enough"} · ${plural(found.count, "inbox", "inboxes")} · not shown again.`,
  inboxes: {
    title: "Choose an inbox",
    intro: "Inboxes your key reaches. Patches reach only the one you choose.",
    pending: "They appear here once Patchy has checked the key.",
    eventsOnly: "Only receives events, so it can't be connected",
    more: (shown: number) => `Showing the first ${shown} inboxes.`,
    none: "This key reaches no inboxes. Make one in Pidgeon, then find inboxes again.",
    missing: "Choose an inbox."
  },
  access: {
    title: "Patches may",
    legend: "What patches may do",
    read: {
      title: "Read",
      points: ["Its mail and labels", "Nothing changes in Pidgeon"]
    },
    send: {
      title: "Read and send",
      points: [
        "Also reply, send, and set status and labels",
        "As this inbox, for the person using the patch; needs a Send key"
      ]
    },
    missing: "Choose what patches may do: Read, or Read and send."
  },
  /** The line under the choices once an inbox and access are picked. */
  review: (access: string, email: string) =>
    access === "send"
      ? `Patches will read ${email} and reply and send from it, and nothing else in your Pidgeon account.`
      : `Patches will read ${email}, and nothing else in your Pidgeon account. Nothing changes in Pidgeon.`,
  name: { example: "support", describe: "support@your-domain.example, the shared inbox" },
  once: {
    reads: "this inbox's mail",
    also: "With Read and send, patches reply and send from it, as the person using the patch",
    cannot: "What builders' agents send while they build goes nowhere",
    caveat: "Revoking the key in Pidgeon stops the connection until a new key replaces it."
  },
  without:
    "It checks your key with Pidgeon without the page ever showing it back. Turn JavaScript on for this page to connect.",
  relock: "Paste the key again and find inboxes: your other choices are kept.",
  actions: { refresh: "Refresh labels", access: "Change access", rotate: "Replace key" },
  results: {
    connect: (email: string) =>
      `Connected to ${email}. Patches reach this inbox only, though the key reaches your whole Pidgeon account.`,
    rotate: (email: string) => `Key replaced. Patches still reach only ${email}.`,
    access: (send: boolean) =>
      `Patches may now ${send ? "read and send" : "read"}. Refresh a patch to get its new client.`,
    refresh:
      "Labels refreshed. Existing patches keep their pinned labels; regenerate before publishing against the new ones.",
    reconnect: "Key tested and resumed. Its snapshot revision is unchanged.",
    delete:
      "Disconnected. Patchy forgot its key; revoke it in Pidgeon's dashboard under API keys. The inbox and its mail stay in Pidgeon."
  },
  tag: "Test key, mail stays in Pidgeon",
  credential: {
    label: "Pidgeon key",
    detail: (email: string) =>
      `Stored, encrypted · reaches the whole Pidgeon account · patches reach ${email} only`
  },
  facts: {
    address: "Inbox",
    may: "Patches may",
    key: "Key",
    keyValue: (test: boolean) =>
      `${test ? "Test" : "Live"} · reaches the whole Pidgeon account; Patchy keeps patches to this inbox`,
    sendsToday: "Sends today",
    sendsUnread: "Couldn't be read",
    sendsCount: (count: number, budget: number) => `${count} of ${budget} · resets at 00:00 UTC`
  },
  reads: {
    heading: "What patches can read and do",
    summary: (email: string, send: boolean, labels: number) =>
      `${email}: threads and messages${send ? ", and replies, sends and triage from it" : ". Nothing changes in Pidgeon"}. ${labels === 0 ? "No labels." : `${plural(labels, "label", "labels")}.`}`
  },
  testKey: {
    title: "This connection uses a test key",
    text: (email: string) =>
      `Mail patches send from ${email} stays in Pidgeon. For real mail, replace the key with a live one of the same account.`,
    fix: "Replace key"
  },
  consequences: {
    delete:
      "No stored patch version declares it. Disconnecting forgets its key and frees the name; revoke the key in Pidgeon yourself. The inbox and its mail stay in Pidgeon, and the snapshots patches were published against are kept. This can't be undone.",
    disconnect:
      "Patches that declare it can't read or send until an admin resumes it. Patchy keeps its key, so resuming checks the key still works and needs nothing new.",
    unsettled: (count: number) =>
      `${count === 1 ? "One email is" : `${count} emails are`} waiting for a member of the Pidgeon account to approve, or for Pidgeon to say whether ${count === 1 ? "it" : "they"} left. Approved after this, ${count === 1 ? "it" : "they"} still go${count === 1 ? "es" : ""} out.`
  },
  rotate: {
    title: (name: string) => `Replace the key for ${name}`,
    consequence:
      "Paste a new Pidgeon key of the same account. Patchy checks it reaches this inbox and can do what patches may, then saves it with a fresh snapshot. Revoke the old key in Pidgeon afterwards.",
    submit: "Replace key"
  },
  change: {
    title: (name: string) => `Change what patches may do with ${name}`,
    consequence:
      "Read takes effect at once. Read and send checks first that the stored key can send. Published patches keep working; refresh one to get its new client.",
    submit: "Change access"
  },
  refusalTitles: {
    pidgeon_key_cant_send: "Read and send needs a Send key",
    pidgeon_key_stopped: "The stored key stopped working",
    pidgeon_stored_key_cant_send: "Read and send needs a Send key"
  }
} as const;

export const integration = {
  key: "pidgeon",
  label: copy.label,
  mark: { logo: "pidgeon" }
} as const;
export const offer = { integration, line: copy.offer };
/** What recent calls keep of a Pidgeon call. */
export const logged = copy.logged;
export const actions: View.Actions = copy.actions;

const accessLabel = (access: Keys.Access) =>
  access === "send" ? copy.access.send.title : copy.access.read.title;

/** A sentence about a Pidgeon connection, or `other` for any other connection. */
const about =
  (other: string, words: (display: Connection["display"]) => string) =>
  (connection: ConnectionStore.Connection) =>
    connection.integration === "pidgeon" ? words(connection.display) : other;

export const results = {
  connect: about("Connected.", (display) => copy.results.connect(display.email)),
  rotate: about("Key replaced.", (display) => copy.results.rotate(display.email)),
  access: about("Access changed.", (display) => copy.results.access(display.access === "send")),
  refresh: copy.results.refresh,
  reconnect: copy.results.reconnect,
  delete: copy.results.delete
};

export const source = (connection: Connection) => connection.display.email;
/** The label beside a test connection's name, wherever it's shown. */
export const tag = (connection: Connection) => (connection.display.test ? copy.tag : undefined);
/** What it holds, as Settings names it: the pasted key, never shown again. */
export const credential = (connection: Connection) => ({
  label: copy.credential.label,
  detail: copy.credential.detail(connection.display.email)
});
/** What patches may do, which Change access changes. */
export const allowed = (connection: Connection) => accessLabel(connection.display.access);
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  [copy.facts.address, connection.display.email],
  [copy.facts.may, accessLabel(connection.display.access)],
  [copy.facts.key, copy.facts.keyValue(connection.display.test)]
];
/**
 * Today's emails against the connection's daily budget, each counted once when its draft key is
 * first sent, while it may send or has sent today; `count` is undefined when it couldn't be read.
 */
export const sendsToday = (
  connection: Connection,
  count: number | undefined,
  budget: number
): ReadonlyArray<readonly [string, string]> =>
  connection.display.access !== "send" && (count ?? 0) === 0
    ? []
    : [
        [
          copy.facts.sendsToday,
          count === undefined ? copy.facts.sendsUnread : copy.facts.sendsCount(count, budget)
        ]
      ];

/** "support@…: threads and messages…", then the inbox's labels. */
export const reads = (snapshot: PidgeonSnapshot) => ({
  heading: copy.reads.heading,
  summary: copy.reads.summary(
    snapshot.address.email,
    snapshot.access === "send",
    snapshot.labels.length
  ),
  items: snapshot.labels.slice(0, 10).map((label) => label.name),
  more: Math.max(0, snapshot.labels.length - 10)
});

/**
 * Why a Pidgeon connection needs an admin: a test key, whose mail stays in Pidgeon, so real mail
 * needs a live key of the same account.
 */
export const attention = (connection: Connection): View.Attention | undefined =>
  connection.display.test
    ? {
        tone: "warning",
        title: copy.testKey.title,
        text: copy.testKey.text(connection.display.email),
        fixes: [{ href: View.connectionPath(connection.id, "rotate"), label: copy.testKey.fix }]
      }
    : undefined;

export const consequences = {
  delete: copy.consequences.delete,
  disconnect: copy.consequences.disconnect
};
/** What deleting adds when emails may still leave without Patchy, or nothing. */
export const unsettled = (count: number) =>
  count === 0 ? undefined : copy.consequences.unsettled(count);

/** Refusals about the key or the inbox, shown under their part of the form. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["pidgeon_key_rejected", "key"],
  ["pidgeon_key_cant_send", "key"],
  ["pidgeon_other_account", "key"],
  ["pidgeon_inbox_not_found", "address"],
  ["pidgeon_no_inbox", "address"],
  ["pidgeon_stored_key_cant_send", "access"]
]);
/** A refusal's bold first line, where the message reads as its explanation. */
export const refusalTitles: ReadonlyMap<string, string> = new Map(
  Object.entries(copy.refusalTitles)
);

// ---------- the connect page ----------

export const connectPath = View.connectPath(integration.key);
/** Find inboxes posts the key here; a route, so a literal. */
export const addressesPath = "/settings/integrations/connect/pidgeon/addresses";
/** Where the connections pages serve `connectScript`; "assets" is a reserved company handle. */
export const connectScriptPath = "/assets/pidgeon-connect.js";

/** The access choice, as connect and Change access offer it. */
export const accessCards = (checked: string | undefined) =>
  choiceCards("access", [
    {
      value: "read",
      title: copy.access.read.title,
      points: [...copy.access.read.points],
      checked: checked === "read"
    },
    {
      value: "send",
      title: copy.access.send.title,
      points: [...copy.access.send.points],
      checked: checked === "send"
    }
  ]);

/** The inbox choices the listing found. */
const tiles = (inboxes: ReadonlyArray<Keys.Listed>) =>
  tileOptions(
    "address",
    inboxes.map((inbox): TileOption => ({
      value: inbox.id,
      name: inbox.email,
      text: inbox.eventsOnly ? copy.inboxes.eventsOnly : (inbox.displayName ?? ""),
      mark: monogram(inbox.email.slice(0, inbox.email.indexOf("@"))),
      disabled: inbox.eventsOnly,
      data: { email: inbox.email }
    }))
  );

/**
 * What finding inboxes answers the page's script: the key's status line, which takes the place
 * of the key field's hint (so it keeps that node's id and class), then the inbox choices. The
 * script swaps each into the page by its `data-pidgeon-*` mark.
 */
export const inboxesFragment = (found: {
  readonly test: boolean;
  readonly level: Keys.Level;
  readonly inboxes: ReadonlyArray<Keys.Listed>;
  readonly more: boolean;
}) =>
  `<p class="field-hint" id="pidgeon-key-hint" data-pidgeon-key-status>${escapeHtml(copy.status({ test: found.test, level: found.level, count: found.inboxes.length }))}</p><div data-pidgeon-addresses>${found.inboxes.length === 0 ? `<p class="meta">${escapeHtml(copy.inboxes.none)}</p>` : tiles(found.inboxes)}${found.more ? `<p class="meta">${escapeHtml(copy.inboxes.more(found.inboxes.length))}</p>` : ""}</div>`;

/**
 * A refusal of the key as the script shows it: the key field's error, under the key, the node
 * core's field draws for a refusal after a submit.
 */
export const keyRefusalFragment = (refusal: View.Notice) =>
  `<p class="field-error" id="pidgeon-key-error" role="alert" data-pidgeon-key-error>${escapeHtml(Fields.refusalText(refusal))}</p>`;

/** What the page's script reads: where Find inboxes posts, its words, and a refused choice. */
const scriptFields = (submitted: Submitted) =>
  `<span hidden data-pidgeon-connect data-addresses="${escapeAttribute(addressesPath)}"${submitted.address === undefined ? "" : ` data-kept-address="${escapeAttribute(submitted.address)}"`} data-find="${escapeAttribute(copy.key.find)}" data-checking="${escapeAttribute(copy.key.checking)}" data-unchecked="${escapeAttribute(copy.key.unchecked)}" data-unreached="${escapeAttribute(copy.key.unreached)}" data-review-read="${escapeAttribute(copy.review("read", "{email}"))}" data-review-send="${escapeAttribute(copy.review("send", "{email}"))}"></span>`;

// ---------- Replace key and Change access ----------

/** The key, as connect and Replace key ask for it. */
const keyField: Fields.Spec = {
  kind: "secret",
  id: "pidgeon-key",
  name: "key",
  field: "key",
  label: copy.key.label,
  hint: copy.key.hint,
  placeholder: "pgn_…"
};

export const rotate = {
  title: copy.rotate.title,
  consequence: copy.rotate.consequence,
  submit: copy.rotate.submit,
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.render(keyField, submitted, refusal, true),
  shows: ["key"]
} as const;
export const access = {
  title: copy.change.title,
  consequence: copy.change.consequence,
  submit: copy.change.submit,
  fields: (submitted: Submitted, refusal?: View.Notice) => {
    const error = Fields.errorAt("access", refusal);
    const choices = choiceGroup({
      id: "pidgeon-access",
      legend: copy.access.title,
      ...(error === undefined ? {} : { error }),
      choices: accessCards(submitted.access)
    });
    return error === undefined ? choices : Fields.focused(choices);
  },
  shows: ["access"],
  initial: (connection: ConnectionStore.Connection) =>
    connection.integration === "pidgeon" ? { access: connection.display.access } : {}
} as const;

/** What the connect page asks for, in the shared frame: checking the key unlocks the rest. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: { title: copy.getIt.title, steps: [copy.getIt.step] },
  paste: {
    title: copy.key.title,
    fields: [keyField],
    // Find inboxes waits hidden for the page's script, which runs it.
    after: () =>
      `<div class="btn-group" data-pidgeon-find-wrap hidden>${button(copy.key.find, { type: "button", data: { "pidgeon-find": "" } })}</div>`
  },
  // The section titles label these parts; a refusal at one reads in a group of its own, under it.
  choose: (submitted, refusal) => {
    const at = (id: string, legend: string, field: View.Field, choices: string) => {
      const error = Fields.errorAt(field, refusal);
      return error === undefined ? choices : choiceGroup({ id, legend, error, choices });
    };
    return [
      {
        title: copy.inboxes.title,
        body: `<p class="meta">${escapeHtml(copy.inboxes.intro)}</p>${at("pidgeon-address", copy.inboxes.title, "address", `<div data-pidgeon-addresses><p class="meta">${escapeHtml(copy.inboxes.pending)}</p></div>`)}`
      },
      {
        title: copy.access.title,
        body: `${at("pidgeon-access", copy.access.legend, "access", accessCards(submitted.access))}<p class="meta" data-pidgeon-review hidden></p>`
      }
    ];
  },
  name: copy.name,
  once: {
    reads: copy.once.reads,
    devReads: true,
    also: [copy.once.also],
    cannot: [copy.once.cannot],
    caveat: copy.once.caveat
  },
  script: {
    fields: scriptFields,
    src: connectScriptPath,
    without: copy.without,
    relock: copy.relock
  }
};

const refused = (field: View.Field, message: string): View.Notice => ({
  message,
  code: "invalid_credentials",
  status: 422,
  field
});

/**
 * What an admin submitted as one secret, or the refusal at the part that stops it. Connect takes
 * the key, the inbox and access; Replace key a key; Change access only the access.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  const key = (form.key ?? "").trim();
  if (current !== undefined && form.key === undefined) {
    if (form.access !== "read" && form.access !== "send")
      return refused("access", copy.access.missing);
    return Keys.changeSecret({ access: form.access });
  }
  if (key === "") return refused("key", copy.key.missing);
  if (current !== undefined) return Keys.changeSecret({ key });
  if (form.access !== "read" && form.access !== "send")
    return refused("access", copy.access.missing);
  const inboxId = form.address ?? "";
  if (inboxId === "") return refused("address", copy.inboxes.missing);
  return Keys.connectSecret({ key, inboxId, access: form.access });
};

// ---------- the script ----------

/**
 * Runs the connect page in the shared frame: posts the key to find inboxes, swaps in what comes
 * back and unlocks the sections after it, keeps the review line current, and lets Test and
 * connect post the form once it's ready, through the frame's gate around it. A key changed after
 * finding inboxes locks them again until it's checked. It reads the frame's own markup: the
 * locked sections are the form's disabled fieldsets, and its settings and words sit on the
 * `data-pidgeon-connect` element.
 */
export const connectScript = `(() => {
  const config = document.querySelector("[data-pidgeon-connect]");
  const form = config?.closest("form");
  if (!form) return;
  const words = config.dataset;
  const key = form.elements.namedItem("key");
  const find = form.querySelector("[data-pidgeon-find]");
  const gate = form.querySelector("[data-ready-gate]");
  const review = form.querySelector("[data-pidgeon-review]");
  const steps = [...form.querySelectorAll("fieldset.flow-section:disabled")];
  let listed = false;
  let busy = false;
  form.querySelector("[data-pidgeon-find-wrap]").hidden = false;
  const status = () => form.querySelector("[data-pidgeon-key-status], #pidgeon-key-hint");
  const describe = () => {
    const ids = [status()?.id, form.querySelector("#pidgeon-key-error")?.id].filter(Boolean);
    key.setAttribute("aria-describedby", ids.join(" "));
  };
  const clearError = () => {
    form.querySelector("#pidgeon-key-error")?.remove();
    key.removeAttribute("aria-invalid");
  };
  const setStatus = (node) => {
    status()?.replaceWith(node);
    clearError();
    describe();
  };
  const refuse = (node) => {
    clearError();
    (key.closest(".secret") ?? key).after(node);
    key.setAttribute("aria-invalid", "true");
    describe();
    key.focus();
  };
  const failure = (text) =>
    Object.assign(document.createElement("p"), { className: "field-error", id: "pidgeon-key-error", role: "alert", textContent: text });
  const lock = (off) => {
    for (const step of steps) step.disabled = off;
    if (off) gate.disabled = true;
  };
  const checked = (name) => form.querySelector('input[name="' + name + '"]:checked');
  const update = () => {
    const address = checked("address");
    const access = checked("access");
    const email = address?.dataset.email ?? "";
    const handle = form.elements.namedItem("handle").value.trim();
    gate.disabled = !(listed && address !== null && access !== null && email !== "" && handle !== "");
    review.hidden = !(listed && email !== "" && access !== null);
    if (!review.hidden)
      review.textContent = (access.value === "send" ? words.reviewSend : words.reviewRead).replace("{email}", email);
  };
  const restore = () => {
    const kept = words.keptAddress;
    const address = kept === undefined ? null : form.querySelector('input[name="address"][value="' + CSS.escape(kept) + '"]');
    if (address !== null && !address.disabled) address.checked = true;
  };
  const list = async () => {
    if (busy) return;
    busy = true;
    find.disabled = true;
    find.textContent = words.checking;
    try {
      const response = await fetch(words.addresses, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "text/html" },
        body: new URLSearchParams({ key: key.value })
      });
      const answer = new DOMParser().parseFromString(await response.text(), "text/html");
      const error = answer.querySelector("[data-pidgeon-key-error]");
      const addresses = answer.querySelector("[data-pidgeon-addresses]");
      if (!response.ok || error !== null || addresses === null) {
        listed = false;
        lock(true);
        refuse(error ?? failure(words.unchecked));
        return;
      }
      setStatus(answer.querySelector("[data-pidgeon-key-status]"));
      form.querySelector("[data-pidgeon-addresses]").replaceWith(addresses);
      listed = true;
      // A refused submit's summary said to check the key again; now it has been.
      form.querySelector("[data-relock]")?.remove();
      lock(false);
      restore();
      update();
      (checked("address") ?? form.querySelector('input[name="address"]:not(:disabled)'))?.focus();
    } catch {
      refuse(failure(words.unreached));
    } finally {
      busy = false;
      find.disabled = false;
      find.textContent = words.find;
    }
  };
  find.addEventListener("click", list);
  key.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      list();
    }
  });
  key.addEventListener("input", () => {
    if (!listed) return;
    listed = false;
    lock(true);
    update();
  });
  form.addEventListener("change", update);
  form.addEventListener("input", update);
  form.addEventListener("submit", (event) => {
    if (gate.disabled) event.preventDefault();
  });
  update();
})();
`;
