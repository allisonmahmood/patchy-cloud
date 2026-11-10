import type { PidgeonSnapshot } from "@patchy/api";
import {
  button,
  choiceCards,
  choiceGroup,
  escapeAttribute,
  escapeHtml,
  field,
  input,
  monogram,
  radio,
  select,
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
 * What the connections pages say about Pidgeon, and its connect page. The admin key is typed into
 * the page and travels only in the bodies of the admin's own requests; nothing here ever writes it
 * back, so a refused submit asks for it again.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

export const integration = { key: "pidgeon", label: "Pidgeon email", mark: "Pi" } as const;
export const offer = { integration, line: "Read and send from one address" };
/** What recent calls keep of a Pidgeon call. */
export const logged =
  "Each call keeps its operation and the ids it named, and a send its subject and recipients; message bodies and search text are never logged.";
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

/** What became of the key a replacement retired: revoked, or still live until Test revokes it. */
const revoked = (display: Connection["display"]) =>
  (display.retired ?? []).length === 0
    ? "revoked the old one"
    : "couldn't revoke the old one yet, so it's still active in Pidgeon";

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
      `Patchy made a new ${display.access} key for ${display.email}, saved it with a fresh snapshot, and ${revoked(display)}. Your admin key wasn't stored.`
  ),
  access: about(
    "Access changed.",
    (display) =>
      `Patches may now ${display.access === "send" ? "read and send" : "read"}. Patchy made a new key at that access and ${revoked(display)}. Refresh a patch to get its new client.`
  ),
  refresh:
    "Labels refreshed. Existing patches keep their pinned labels; regenerate before publishing against the new ones.",
  reconnect: "Key tested and resumed. Its snapshot revision is unchanged.",
  delete: "Disconnected, and its key revoked in Pidgeon. The address and its mail stay in Pidgeon."
};

export const source = (connection: Connection) => connection.display.email;
/** The label beside a test connection's name, wherever it's shown. */
export const tag = (connection: Connection) =>
  connection.display.test ? "Test, mail stays in Pidgeon" : undefined;
/** What it holds, as Settings names it: Patchy's own key for the address, never the admin key. */
export const credential = (connection: Connection) => ({
  label: "Address key",
  detail: `Stored · Patchy's own, for ${connection.display.email} · made ${connection.display.key.madeAt.slice(0, 10)}`
});
/** What its key may do, which Change access changes. */
export const allowed = (connection: Connection) => accessLabel(connection.display.access);
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

/**
 * Why a Pidgeon connection needs an admin: old keys Patchy replaced but hasn't revoked, which
 * stay live in Pidgeon though the connection works, and Test tries to revoke again; else a test
 * address, whose mail stays in Pidgeon and which Pidgeon deletes a day after it's made, so real
 * mail needs a live address. The old keys come first: they're what an admin must act on.
 */
export const attention = (connection: Connection): View.Attention | undefined => {
  const keys = connection.display.retired ?? [];
  if (keys.length > 0) {
    const named = keys.map((key) => key.name);
    return {
      tone: "warning",
      title:
        keys.length === 1
          ? "The old key is still active in Pidgeon"
          : "The old keys are still active in Pidgeon",
      text: `Patchy switched to the new key but hasn't revoked ${keys.length === 1 ? `the old one, named ${named[0]}` : `the old ones, named ${named.join(" and ")}`}. Test tries again, or revoke ${keys.length === 1 ? "it" : "them"} in Pidgeon under Developers › API keys.`,
      fixes: [
        {
          href: View.connectionPath(connection.id, "test"),
          label: "Test",
          primary: true,
          post: true
        }
      ]
    };
  }
  if (!connection.display.test) return undefined;
  return {
    tone: "warning",
    title: "This is a test address",
    text: `Its mail stays in Pidgeon, and Pidgeon deletes ${connection.display.email} a day after it was made. For real mail, connect a live address with a live admin key.`,
    fixes: [{ href: connectPath, label: "Connect a live address" }]
  };
};

export const consequences = {
  delete:
    "No stored patch version declares it. Disconnecting revokes Patchy's key in Pidgeon and frees the name; the address and its mail stay in Pidgeon, and the snapshots patches were published against are kept. This can't be undone.",
  disconnect:
    "Patches that declare it can't read or send until an admin resumes it. Patchy keeps its key, so resuming needs no admin key; it checks the key still works first."
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

const KEY_HINT =
  "Patchy uses it once, to find or create the address and make its own key for it. It's never stored.";

export const connectPath = View.connectPath(integration.key);
/** Find addresses posts the admin key here; a route, so a literal. */
export const addressesPath = "/settings/integrations/connect/pidgeon/addresses";
/** Where the connections pages serve `connectScript`; "assets" is a reserved company handle. */
export const connectScriptPath = "/assets/pidgeon-connect.js";

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
      mark: monogram(address.email.slice(0, address.email.indexOf("@"))),
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
const newAddress = (domains: ReadonlyArray<string>, kept: Submitted) =>
  `<div class="stack" data-pidgeon-new hidden>${field({
    id: "pidgeon-local",
    label: "New address",
    hint: `What comes before the @, on one of your Pidgeon's domains or Pidgeon's shared ${Keys.SHARED_DOMAIN}.`,
    control: (aria) =>
      input(aria, { name: "local_part", value: kept.local_part ?? "", maxlength: 64, mono: true })
  })}${field({
    id: "pidgeon-domain",
    label: "Domain",
    control: (aria) =>
      select(aria, {
        name: "domain",
        choices: domains.map((domain) => ({ value: domain, label: `@${domain}` })),
        ...(kept.domain === undefined ? {} : { value: kept.domain }),
        width: "md"
      })
  })}${field({
    id: "pidgeon-display",
    label: "Display name",
    hint: "What people see in their inbox.",
    control: (aria) =>
      input(aria, { name: "display_name", value: kept.display_name ?? "", maxlength: 120 })
  })}${choiceGroup({
    id: "pidgeon-policy",
    legend: "Who it may write to",
    hint: "Replies only: patches answer people who wrote in, and can't start a conversation with a stranger. Anyone: patches can email any address.",
    choices: `${radio({ name: "send_policy", value: "reply_only", label: "Replies only (recommended)", checked: (kept.send_policy ?? "reply_only") === "reply_only" })}${radio({ name: "send_policy", value: "open", label: "Anyone", checked: kept.send_policy === "open" })}`
  })}<p class="meta">Patchy creates it in your Pidgeon with an inbox. Disconnecting later leaves the address and its mail in Pidgeon.</p></div>`;

/**
 * What finding addresses answers the page's script: the key's status line, which takes the place
 * of the key field's hint (so it keeps that node's id and class), then the address choices and
 * the new address's fields. The script swaps each into the page by its `data-pidgeon-*` mark.
 */
export const addressesFragment = (found: {
  readonly test: boolean;
  readonly addresses: ReadonlyArray<Keys.Address>;
  readonly more: boolean;
  readonly domains: ReadonlyArray<string>;
}) =>
  `<p class="field-hint" id="pidgeon-key-hint" data-pidgeon-key-status>${escapeHtml(`${found.test ? "Test" : "Live"} · ${found.addresses.length === 1 ? "1 address" : `${found.addresses.length} addresses`} · not stored.`)}</p><div data-pidgeon-addresses>${tiles(found.addresses, found.domains)}${found.more ? `<p class="meta">${escapeHtml(`Showing the first ${found.addresses.length} addresses.`)}</p>` : ""}${newAddress(found.domains, {})}</div>`;

/**
 * A refusal of the admin key as the script shows it: the key field's error, under the key, the
 * node core's field draws for a refusal after a submit.
 */
export const keyRefusalFragment = (refusal: View.Notice) =>
  `<p class="field-error" id="pidgeon-key-error" role="alert" data-pidgeon-key-error>${escapeHtml(Fields.refusalText(refusal))}</p>`;

/** What the page's script reads: where Find addresses posts, and a refused submit's choices. */
const scriptFields = (submitted: Submitted) => {
  const kept = (["address", "local_part", "domain", "display_name", "send_policy"] as const)
    .flatMap((name) => {
      const value = submitted[name];
      return value === undefined
        ? []
        : [` data-kept-${name.replace("_", "-")}="${escapeAttribute(value)}"`];
    })
    .join("");
  // ConnectionPage keeps a refused submit's attempt or makes a fresh one.
  return `<input type="hidden" name="attempt" value="${escapeAttribute(submitted.attempt ?? "")}"><span hidden data-pidgeon-connect data-addresses="${escapeAttribute(addressesPath)}"${kept}></span>`;
};

// ---------- Replace key and Change access ----------

/** The admin key, as Replace key and Change access ask for it: used once and never stored. */
const adminKey: Fields.Spec = {
  kind: "secret",
  id: "pidgeon-key",
  name: "key",
  field: "key",
  label: "Admin key",
  hint: KEY_HINT,
  placeholder: "pgn_…"
};
const attemptField = (submitted: Submitted) =>
  `<input type="hidden" name="attempt" value="${escapeAttribute(submitted.attempt ?? "")}">`;

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence:
    "Patchy uses an admin key once to make a new key for the same address at the same access, checks it and saves it with a fresh snapshot. Then the old key revokes itself. Use this when Patchy's key stopped working, for example because its admin key was revoked.",
  submit: "Replace key",
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    `${attemptField(submitted)}${Fields.render(adminKey, submitted, refusal, true)}`,
  shows: ["key"]
} as const;
export const access = {
  title: (name: string) => `Change what patches may do with ${name}`,
  consequence:
    "Patchy uses an admin key once to make a new key for the same address at the access you choose, and saves it with a fresh snapshot. Then the old key revokes itself. Published patches keep working; refresh one to get its new client.",
  submit: "Change access",
  fields: (submitted: Submitted, refusal?: View.Notice) => {
    const error = Fields.errorAt("access", refusal);
    const choices = choiceGroup({
      id: "pidgeon-access",
      legend: "Patches may",
      ...(error === undefined ? {} : { error }),
      choices: accessCards(submitted.access)
    });
    // The current access starts chosen, so the admin key is what's left to type.
    return `${attemptField(submitted)}${error === undefined ? choices : Fields.focused(choices)}${Fields.render(adminKey, submitted, refusal, true)}`;
  },
  shows: ["access", "key"],
  initial: (connection: ConnectionStore.Connection) =>
    connection.integration === "pidgeon" ? { access: connection.display.access } : {}
} as const;

/** What the connect page asks for, in the shared frame: discovery unlocks the address and access. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Make an admin key",
    steps: [
      "In Pidgeon, open Developers › API keys › New key. Choose Admin, for every address rather than a few, and name it Patchy."
    ]
  },
  paste: {
    title: "Paste the admin key",
    fields: [adminKey],
    // Find addresses waits hidden for the page's script, which runs it.
    after: () =>
      `<div class="btn-group" data-pidgeon-find-wrap hidden>${button("Find addresses", { type: "button", data: { "pidgeon-find": "" } })}</div>`
  },
  // The section titles label these parts; a refusal at one reads in a group of its own, under it.
  choose: (submitted, refusal) => {
    const at = (id: string, legend: string, field: View.Field, choices: string) => {
      const error = Fields.errorAt(field, refusal);
      return error === undefined ? choices : choiceGroup({ id, legend, error, choices });
    };
    return [
      {
        title: "Choose an address",
        body: `<p class="meta">Addresses your key reaches, or a new one.</p>${at("pidgeon-address", "Address", "address", `<div data-pidgeon-addresses><p class="meta">They appear here once Patchy has checked the key.</p>${tiles([], ["your domains", Keys.SHARED_DOMAIN])}</div>`)}`
      },
      {
        title: "Patches may",
        body: `${at("pidgeon-access", "What patches may do", "access", accessCards(submitted.access))}<div data-pidgeon-review hidden><p class="strong" data-pidgeon-review-title></p><p class="meta" data-pidgeon-review-policy></p></div>`
      }
    ];
  },
  name: { example: "hello", describe: "hello@your-domain.example, the front door" },
  once: {
    reads: "this address's mail",
    devReads: true,
    also: ["With Read and send, patches reply and send from it, as the person using the patch"],
    cannot: ["What builders' agents send while they build goes nowhere"],
    caveat: "Revoking your admin key in Pidgeon later disconnects addresses connected with it."
  },
  script: {
    fields: scriptFields,
    src: connectScriptPath,
    without:
      "It checks your admin key with Pidgeon without the page ever showing it back. Turn JavaScript on for this page to connect."
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
 * Runs the connect page in the shared frame: posts the admin key to find addresses, swaps in what
 * comes back and unlocks the sections after it, keeps the review line current, and lets Test and
 * connect post the form once it's ready, through the frame's gate around it. A key changed after
 * finding addresses locks them again
 * until it's checked. It reads the frame's own markup: the locked sections are the form's disabled
 * fieldsets, and its settings sit on the `data-pidgeon-connect` element.
 */
export const connectScript = `(() => {
  const config = document.querySelector("[data-pidgeon-connect]");
  const form = config?.closest("form");
  if (!form) return;
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
    gate.disabled = !(listed && address !== null && access !== null && email !== "" && handle !== "");
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
    const kept = config.dataset;
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
  const list = async () => {
    if (busy) return;
    busy = true;
    find.disabled = true;
    find.textContent = "Checking…";
    try {
      const response = await fetch(config.dataset.addresses, {
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
        refuse(error ?? failure("Patchy couldn't check the key. Try again."));
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
      refuse(failure("Patchy couldn't reach the instance. Try again."));
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
