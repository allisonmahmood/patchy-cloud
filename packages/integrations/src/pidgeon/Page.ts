import type { PidgeonSnapshot } from "@patchy/api";
import {
  choiceCards,
  escapeAttribute,
  escapeHtml,
  patchMark,
  tileOptions,
  type TileOption
} from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Keys from "./Keys.js";

/**
 * What the connections pages say about Pidgeon, and its connect page. The admin key is typed into
 * the page and travels only in the bodies of the admin's own requests; nothing here ever writes it
 * back, so a refused submit asks for it again.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

export const integration = { key: "pidgeon", label: "Pidgeon email" } as const;
export const offer = {
  integration,
  reads: "An email address on Pidgeon: patches read its mail and, if you allow it, send from it.",
  mode: "Company-wide · one address"
};
export const actions: View.Actions = {
  refresh: "Refresh labels",
  access: "Change access",
  rotate: "Replace key"
};

const policies: Readonly<Record<string, string>> = {
  reply_only: "Replies only",
  open: "Writes to anyone",
  list: "Writes to its allow-list"
};
const policyLabel = (policy: string) => policies[policy] ?? policy;
const accessLabel = (access: Keys.Access) => (access === "send" ? "Read and send" : "Read");

/** A sentence about a Pidgeon connection's key, or `other` for any other connection. */
const about =
  (other: string, words: (display: Connection["display"]) => string) =>
  (connection: ConnectionStore.Connection) =>
    connection.integration === "pidgeon" ? words(connection.display) : other;

export const results = {
  connect: about(
    "Connected.",
    (display) =>
      `Patchy made a ${display.access} key for ${display.email} and kept only that. Your admin key wasn't stored.`
  ),
  rotate: about(
    "Key replaced.",
    (display) =>
      `Patchy made a new ${display.access} key for ${display.email}, saved it with a fresh snapshot, and revoked the old one. Your admin key wasn't stored.`
  ),
  access: about(
    "Access changed.",
    (display) =>
      `Patches may now ${display.access === "send" ? "read and send" : "read"}. Patchy made a new key at that access and revoked the old one. Refresh a patch to get its new client.`
  ),
  refresh:
    "Labels refreshed. Existing patches keep their pinned labels; regenerate before publishing against the new ones.",
  reconnect: "Key tested and reconnected. Its snapshot revision is unchanged.",
  delete:
    "Connection deleted, and its key revoked in Pidgeon. The address and its mail stay in Pidgeon."
};

export const source = (connection: Connection) => connection.display.email;
/** The label beside a test connection's name, wherever it's shown. */
export const tag = (connection: Connection) =>
  connection.display.test ? "Test · mail stays in Pidgeon" : undefined;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Address", connection.display.email],
  ["Writes to", policyLabel(connection.display.sendPolicy)],
  ["Patches may", accessLabel(connection.display.access)],
  ["Key", `Patchy's own, for this address · made ${connection.display.key.madeAt.slice(0, 10)}`]
];
/**
 * Today's sends and replies against the connection's daily budget, every attempt counted, while
 * its key can send or it has sent today; `count` is undefined when it couldn't be read.
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
          "Sends today",
          count === undefined ? "Couldn't be read" : `${count} of ${budget} · resets at 00:00 UTC`
        ]
      ];

/** "support@…: threads, messages and attachment text…", then the address's labels. */
export const reads = (snapshot: PidgeonSnapshot) => ({
  heading: "What patches can read and do",
  summary: `${snapshot.address.email}: threads, messages and attachment text${
    snapshot.access === "send"
      ? `, and replies, sends and triage from it. ${
          snapshot.address.sendPolicy === "reply_only"
            ? "It only replies: patches can't start a conversation."
            : snapshot.address.sendPolicy === "list"
              ? "It writes only to its allow-list."
              : "It writes to anyone."
        }`
      : ". Nothing changes in Pidgeon."
  } ${snapshot.labels.length === 0 ? "No labels." : `${snapshot.labels.length === 1 ? "1 label" : `${snapshot.labels.length} labels`}.`}`,
  items: snapshot.labels.slice(0, 10).map((label) => label.name),
  more: Math.max(0, snapshot.labels.length - 10)
});

/** Notices a Pidgeon connection keeps on its page while they hold: old keys not yet revoked. */
export const standing = (connection: Connection): ReadonlyArray<View.Standing> =>
  (connection.display.retired ?? []).map((key) => ({
    tone: "warn" as const,
    title: "The old key is still active in Pidgeon",
    text: `Patchy switched to the new key but hasn't revoked the old one, named ${key.name}. Test connection tries again, or revoke it in Pidgeon under Developers › API keys.`
  }));

export const consequences = {
  delete:
    "No stored patch version declares it. Deleting revokes Patchy's key in Pidgeon and frees the name; the address and its mail stay in Pidgeon, and the snapshots patches were published against are kept. This can't be undone.",
  disconnect:
    "Patches that declare it can't read or send until an admin reconnects it. Patchy keeps its key, so reconnecting needs no admin key; it checks the key still works first."
};

/** Refusals about the admin key or the address, shown under their part of the form. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["pidgeon_admin_key_rejected", "key"],
  ["pidgeon_not_admin", "key"],
  ["pidgeon_partial_admin", "key"],
  ["pidgeon_address_not_found", "address"],
  ["pidgeon_address_mode", "address"],
  ["pidgeon_no_inbox", "address"],
  ["pidgeon_address_taken", "address"],
  ["pidgeon_invalid_address", "address"],
  ["pidgeon_unknown_domain", "address"]
]);
/** A refusal's bold first line, where the message reads as its explanation. */
export const refusalTitles: ReadonlyMap<string, string> = new Map([
  ["pidgeon_not_admin", "That key isn't an admin key"],
  ["pidgeon_partial_admin", "That admin key reaches only some addresses"],
  ["pidgeon_key_stopped", "Patchy's key stopped working"]
]);

// ---------- the connect page ----------

const HOWTO =
  "In Pidgeon, open Developers › API keys › New key. Choose <strong>Admin</strong>, for every address rather than a few, and name it Patchy.";
const KEY_HINT =
  "Patchy uses it once, to find or create the address and make its own key for it. It's never stored.";
const LATER =
  "Rotate it in Pidgeon whenever you like: addresses connected with it keep working. Revoking it disconnects them, so revoke it only to retire it or after a leak, then replace their keys here. A key just for Patchy keeps a revocation to Patchy.";

export const connectPath = View.connectPath(integration.key);
/** Find addresses posts the admin key here; a route, so a literal. */
export const addressesPath = "/company/connections/connect/pidgeon/addresses";
/** Where the connections pages serve `connectScript`; "assets" is a reserved company handle. */
export const connectScriptPath = "/assets/pidgeon-connect.js";

const side = `<aside class="side-panel" aria-label="About connecting Pidgeon"><p class="shelf-label">Before you start</p><p>${HOWTO}</p><p class="shelf-label">What Patchy keeps</p><p>A key for the one address you pick, at the access you choose. Your admin key is used once and never stored.</p><p class="shelf-label">Later</p><p>${escapeHtml(LATER)}</p><p class="shelf-label">Who reads the mail</p><p>Every member, through any patch that declares it, and with Read and send, mail goes out from it too. Builders' agents read it while they build; what they send in dev goes nowhere.</p></aside>`;

const step = (number: number, id: string, title: string, body: string, disabled: boolean) =>
  `<fieldset class="form-step" id="${id}"${disabled ? " disabled data-pidgeon-step" : ""}><legend class="form-step-title"><span class="form-step-number" aria-hidden="true">${number}</span>${escapeHtml(title)}</legend>${body}</fieldset>`;

/** The access choice, as connect and Change access offer it. */
export const accessCards = (checked: string | undefined) =>
  choiceCards("access", [
    {
      value: "read",
      title: "Read",
      points: ["Its mail, labels and attachment text", "Nothing changes in Pidgeon"],
      checked: checked === "read"
    },
    {
      value: "send",
      title: "Read and send",
      points: [
        "Also reply, send, and set status and labels",
        "As this address, for the person using the patch"
      ],
      checked: checked === "send"
    }
  ]);

/** The address choices the listing found: the addresses, then a New address row. */
const tiles = (addresses: ReadonlyArray<Keys.Address>, domains: ReadonlyArray<string>) =>
  tileOptions("address", [
    ...addresses.map((address): TileOption => ({
      value: address.id,
      name: address.email,
      text: `${address.displayName === null ? "" : `${address.displayName} · `}${address.hasInbox ? policyLabel(address.sendPolicy) : "no inbox, can't be connected"}`,
      mark: patchMark(address.email.slice(0, address.email.indexOf("@")), 1),
      disabled: !address.hasInbox,
      data: { email: address.email, policy: address.sendPolicy }
    })),
    {
      value: "new",
      name: "New address",
      text: `On ${domains.join(" or ")}, replies only to start`,
      mark: '<span class="mono mono-placeholder" aria-hidden="true">+</span>',
      placeholder: true
    }
  ]);

/** What a new address takes; shown once New address is picked. */
const newAddress = (domains: ReadonlyArray<string>, kept: Submitted) => {
  const choice = (value: string, title: string, text: string) =>
    `<label class="field-choice"><input class="field-radio" type="radio" name="send_policy" value="${value}"${(kept.send_policy ?? "reply_only") === value ? " checked" : ""}><span><strong>${escapeHtml(title)}</strong><br><span class="supporting-text">${escapeHtml(text)}</span></span></label>`;
  return `<div data-pidgeon-new hidden><label class="field-label" for="pidgeon-local">Address</label><div class="pidgeon-address-row"><input class="field" id="pidgeon-local" name="local_part" value="${escapeAttribute(kept.local_part ?? "")}" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="pidgeon-local-hint"><span aria-hidden="true">@</span><select class="field" name="domain" aria-label="Domain">${domains.map((domain) => `<option value="${escapeAttribute(domain)}"${kept.domain === domain ? " selected" : ""}>${escapeHtml(domain)}</option>`).join("")}</select></div><p class="field-hint" id="pidgeon-local-hint">One of your Pidgeon's domains, or Pidgeon's shared ${Keys.SHARED_DOMAIN}.</p><label class="field-label" for="pidgeon-display">Display name</label><input class="field" id="pidgeon-display" name="display_name" maxlength="120" value="${escapeAttribute(kept.display_name ?? "")}" aria-describedby="pidgeon-display-hint"><p class="field-hint" id="pidgeon-display-hint">What people see in their inbox.</p><fieldset class="pidgeon-policy"><legend class="field-label">Who it may write to</legend>${choice("reply_only", "Replies only (recommended)", "Patches answer people who wrote in. They can't start a conversation with a stranger.")}${choice("open", "Anyone", "Patches can email any address.")}</fieldset><p class="supporting-text">Patchy creates it in your Pidgeon with an inbox. Deleting the connection later leaves the address and its mail in Pidgeon.</p></div>`;
};

/**
 * What finding addresses answers the page's script: the key's line, then the address choices and
 * the new address's fields. The script swaps each into the page by its `data-pidgeon-*` mark.
 */
export const addressesFragment = (found: {
  readonly test: boolean;
  readonly addresses: ReadonlyArray<Keys.Address>;
  readonly more: boolean;
  readonly domains: ReadonlyArray<string>;
}) =>
  `<p class="field-hint" id="pidgeon-key-hint" data-pidgeon-key-status>${escapeHtml(`${found.test ? "Test" : "Live"} · ${found.addresses.length === 1 ? "1 address" : `${found.addresses.length} addresses`} · not stored.`)}</p><div data-pidgeon-addresses>${tiles(found.addresses, found.domains)}${found.more ? `<p class="supporting-text">${escapeHtml(`Showing the first ${found.addresses.length} addresses.`)}</p>` : ""}${newAddress(found.domains, {})}</div>`;

/** A refusal of the admin key as the script shows it, under the key. */
export const keyRefusalFragment = (refusal: View.Notice) =>
  `<div class="note note-refused field-callout" id="pidgeon-key-error" role="alert" data-pidgeon-key-error><strong class="note-title">${escapeHtml(refusal.title ?? refusal.message)}</strong>${refusal.title === undefined ? "" : `<p>${escapeHtml(refusal.message)}</p>`}${refusal.code === undefined ? "" : `<code>${escapeHtml(refusal.code)}</code>`}</div>`;

/**
 * The one-page connect form: the admin key first, then the address, what patches may do and the
 * name, each dim until the key is checked, and a review line above Connect. A refused submit keeps
 * everything typed except the key; the script picks the kept address again once the key is in.
 */
export const renderConnect = (submitted: Submitted, refusal?: View.Notice) => {
  const attempt =
    submitted.attempt !== undefined && Keys.isAttempt(submitted.attempt)
      ? submitted.attempt
      : Keys.newAttempt();
  const key = View.fieldNote("pidgeon-key", "key", KEY_HINT, refusal);
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "Patches declare it by this name, which can't be changed later.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line telling builders what this address is for.",
    refusal
  );
  const at = (field: View.Field) =>
    refusal?.field === field ? View.fieldNote(`pidgeon-${field}`, field, "", refusal).note : "";
  const kept = Object.fromEntries(
    (["address", "local_part", "domain", "display_name", "send_policy"] as const).flatMap(
      (name) => {
        const value = submitted[name];
        return value === undefined ? [] : [[`data-kept-${name.replace("_", "-")}`, value]];
      }
    )
  );
  const form = `<form method="post" action="${escapeAttribute(connectPath)}" novalidate data-pidgeon-connect data-addresses="${escapeAttribute(addressesPath)}"${Object.entries(
    kept
  )
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("")}><input type="hidden" name="attempt" value="${escapeAttribute(attempt)}">${step(
    1,
    "pidgeon-step-key",
    "Admin key",
    `<div class="pidgeon-key-row"><input class="field" id="pidgeon-key" type="password" name="key" placeholder="pgn_…" autocomplete="off" spellcheck="false" aria-label="Admin key"${key.attributes}><button class="btn btn-primary" type="button" data-pidgeon-find hidden>Find addresses</button></div>${key.note}`,
    false
  )}${step(
    2,
    "pidgeon-step-address",
    "Address",
    `<p class="supporting-text">Addresses your key reaches, or a new one.</p>${at("address")}<div data-pidgeon-addresses><p class="supporting-text">They appear here once Patchy has checked the key.</p>${tiles([], ["your domains", Keys.SHARED_DOMAIN])}</div>`,
    true
  )}${step(3, "pidgeon-step-access", "Patches may", `${at("access")}${accessCards(submitted.access)}`, true)}${step(
    4,
    "pidgeon-step-name",
    "Name it",
    `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">pidgeon/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}`,
    true
  )}<div class="note" data-pidgeon-review hidden><strong class="note-title" data-pidgeon-review-title></strong><p data-pidgeon-review-policy></p></div><div class="actions"><button class="btn btn-primary" type="submit" disabled data-pidgeon-submit>Connect</button><a class="btn btn-quiet" href="${escapeAttribute(View.cataloguePath)}">Cancel</a></div></form>`;
  return `<p><a href="${View.indexPath}">Integrations</a> / <a href="${View.cataloguePath}">Connect an integration</a> / Pidgeon email</p><h1 class="page-heading">Connect Pidgeon email</h1><p>About two minutes. You'll need a Pidgeon admin key. Nothing is saved until Patchy has checked the key it makes.</p>${View.notice(refusal)}<noscript><div class="note note-warn" role="alert"><strong class="note-title">This page needs JavaScript</strong><p>It checks your admin key with Pidgeon without the page ever showing it back. Turn JavaScript on for this page to connect.</p></div></noscript><div class="card-split"><div>${form}</div>${side}</div><script defer src="${connectScriptPath}"></script>`;
};

/** The page's own layout: the key beside its button, and the new address's two parts. */
export const styles = `
    .pidgeon-key-row, .pidgeon-address-row { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; }
    .pidgeon-key-row > .field, .pidgeon-address-row > .field { flex: 1 1 14rem; width: auto; }
    .pidgeon-policy { min-width: 0; margin: 0; padding: 0; border: 0; }
`;

// ---------- Replace key and Change access ----------

const adminKeyField = (refusal: View.Notice | undefined) => {
  const note = View.fieldNote("pidgeon-key", "key", KEY_HINT, refusal);
  return `<label class="field-label" for="pidgeon-key">Admin key</label><input class="field" id="pidgeon-key" type="password" name="key" required placeholder="pgn_…" autocomplete="off" spellcheck="false"${note.attributes}>${note.note}`;
};
const attemptField = (submitted: Submitted) =>
  `<input type="hidden" name="attempt" value="${escapeAttribute(
    submitted.attempt !== undefined && Keys.isAttempt(submitted.attempt)
      ? submitted.attempt
      : Keys.newAttempt()
  )}">`;

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence:
    "Patchy uses an admin key once to make a new key for the same address at the same access, checks it and saves it with a fresh snapshot. Then the old key revokes itself. Use this when Patchy's key stopped working, for example because its admin key was revoked.",
  submit: "Replace key",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    `${attemptField(submitted)}${adminKeyField(refusal)}`
};
export const access = {
  title: (name: string) => `Change what patches may do with ${name}`,
  consequence:
    "Patchy uses an admin key once to make a new key for the same address at the access you choose, and saves it with a fresh snapshot. Then the old key revokes itself. Published patches keep working; refresh one to get its new client.",
  submit: "Change access",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    `${attemptField(submitted)}<fieldset class="form-step"><legend class="form-step-title">Patches may</legend>${accessCards(submitted.access)}</fieldset>${adminKeyField(refusal)}`
};

const refused = (field: View.Field, message: string): View.Notice => ({
  message,
  code: "invalid_credentials",
  status: 422,
  field
});

/**
 * What an admin submitted as one secret, or the refusal at the part that stops it. Connect takes
 * the address and access; Replace key keeps the connection's access unless Change access names one.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  const adminKey = (form.key ?? "").trim();
  if (!Keys.isAttempt(form.attempt ?? ""))
    return {
      message: "This form has expired. Reload the page and try again.",
      code: "invalid_request",
      status: 400
    };
  const attempt = form.attempt ?? "";
  if (adminKey === "")
    return refused("key", "Paste a Pidgeon admin key: it starts with pgn_live_ or pgn_test_.");
  const chosen =
    form.access ?? (current?.integration === "pidgeon" ? current.display.access : undefined);
  if (chosen !== "read" && chosen !== "send")
    return refused("access", "Choose what patches may do: Read, or Read and send.");
  if (current !== undefined) return Keys.replaceSecret({ adminKey, attempt, access: chosen });
  const address = form.address ?? "";
  if (address === "") return refused("address", "Pick an address, or create a new one.");
  if (address !== "new")
    return Keys.connectSecret({ adminKey, attempt, access: chosen, address: { id: address } });
  const localPart = (form.local_part ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(localPart))
    return refused(
      "address",
      "Name the new address with letters, digits, dots, hyphens or plus signs before the @."
    );
  const domain = (form.domain ?? "").trim().toLowerCase();
  if (domain === "") return refused("address", "Choose the new address's domain.");
  const displayName = (form.display_name ?? "").trim();
  return Keys.connectSecret({
    adminKey,
    attempt,
    access: chosen,
    address: {
      create: {
        localPart,
        domain,
        displayName: displayName === "" ? null : displayName.slice(0, 120),
        sendPolicy: form.send_policy === "open" ? "open" : "reply_only"
      }
    }
  });
};

// ---------- the script ----------

/**
 * Runs the connect page: posts the admin key to find addresses, swaps in what comes back and
 * enables the rest of the form, keeps the review line current, and lets Connect post the form. A
 * key changed after finding addresses dims the form again until it's checked.
 */
export const connectScript = `(() => {
  const form = document.querySelector("form[data-pidgeon-connect]");
  if (form === null) return;
  const key = form.elements.namedItem("key");
  const find = form.querySelector("[data-pidgeon-find]");
  const submit = form.querySelector("[data-pidgeon-submit]");
  const review = form.querySelector("[data-pidgeon-review]");
  const steps = [...form.querySelectorAll("[data-pidgeon-step]")];
  let listed = false;
  let busy = false;
  find.hidden = false;
  const statusLine = () => form.querySelector("[data-pidgeon-key-status], #pidgeon-key-hint, [data-pidgeon-key-error]");
  const setStatus = (node) => {
    statusLine()?.replaceWith(node);
    key.setAttribute("aria-describedby", node.id || "pidgeon-key-hint");
  };
  const dim = (off) => {
    for (const step of steps) step.disabled = off;
    if (off) submit.disabled = true;
  };
  const checked = (name) => form.querySelector('input[name="' + name + '"]:checked');
  const update = () => {
    const address = checked("address");
    const fresh = form.querySelector("[data-pidgeon-new]");
    if (fresh !== null) {
      fresh.hidden = address?.value !== "new";
      for (const control of fresh.querySelectorAll("input, select")) control.disabled = fresh.hidden;
    }
    const access = checked("access");
    const localPart = form.elements.namedItem("local_part")?.value.trim() ?? "";
    const domain = form.elements.namedItem("domain")?.value ?? "";
    const isNew = address?.value === "new";
    const email = isNew ? (localPart === "" ? "" : localPart + "@" + domain) : (address?.dataset.email ?? "");
    const policy = isNew ? (checked("send_policy")?.value ?? "reply_only") : (address?.dataset.policy ?? "");
    const handle = form.elements.namedItem("handle").value.trim();
    const ready = listed && address !== null && access !== null && email !== "" && handle !== "";
    submit.disabled = !ready;
    review.hidden = !(listed && email !== "" && access !== null);
    if (!review.hidden) {
      const name = email.slice(0, email.indexOf("@") + 1);
      review.querySelector("[data-pidgeon-review-title]").textContent =
        "Patchy will make a " + access.value + " key for " + email + " and keep only that.";
      review.querySelector("[data-pidgeon-review-policy]").textContent =
        access.value === "read"
          ? "Patches read its mail. Nothing changes in Pidgeon."
          : policy === "reply_only"
            ? name + " only replies: patches answer people who wrote in, and can't start a conversation with a stranger."
            : policy === "list"
              ? name + " writes only to its allow-list in Pidgeon."
              : name + " writes to anyone: patches can start a conversation with any address.";
    }
  };
  const restore = () => {
    const kept = form.dataset;
    const address = kept.keptAddress === undefined ? null : form.querySelector('input[name="address"][value="' + CSS.escape(kept.keptAddress) + '"]');
    if (address !== null && !address.disabled) address.checked = true;
    const fields = { local_part: kept.keptLocalPart, domain: kept.keptDomain, display_name: kept.keptDisplayName };
    for (const [name, value] of Object.entries(fields)) {
      const control = form.elements.namedItem(name);
      if (control !== null && value !== undefined) control.value = value;
    }
    const policy = kept.keptSendPolicy === undefined ? null : form.querySelector('input[name="send_policy"][value="' + CSS.escape(kept.keptSendPolicy) + '"]');
    if (policy !== null) policy.checked = true;
  };
  const refuse = (node) => {
    setStatus(node);
    key.setAttribute("aria-invalid", "true");
    key.focus();
  };
  const list = async () => {
    if (busy) return;
    busy = true;
    find.disabled = true;
    find.textContent = "Checking…";
    try {
      const response = await fetch(form.dataset.addresses, {
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
        dim(true);
        refuse(error ?? Object.assign(document.createElement("div"), { className: "note note-refused field-callout", id: "pidgeon-key-error", role: "alert", textContent: "Patchy couldn't check the key. Try again." }));
        return;
      }
      setStatus(answer.querySelector("[data-pidgeon-key-status]"));
      key.removeAttribute("aria-invalid");
      form.querySelector("[data-pidgeon-addresses]").replaceWith(addresses);
      listed = true;
      dim(false);
      restore();
      update();
      (checked("address") ?? form.querySelector('input[name="address"]:not(:disabled)'))?.focus();
    } catch {
      refuse(Object.assign(document.createElement("div"), { className: "note note-refused field-callout", id: "pidgeon-key-error", role: "alert", textContent: "Patchy couldn't reach the instance. Try again." }));
    } finally {
      busy = false;
      find.disabled = false;
      find.textContent = "Find addresses";
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
    dim(true);
    update();
  });
  form.addEventListener("change", update);
  form.addEventListener("input", update);
  form.addEventListener("submit", (event) => {
    if (submit.disabled) event.preventDefault();
  });
  update();
})();
`;
