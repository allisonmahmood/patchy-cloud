import type { PidgeonSnapshot } from "@patchy/api";
import type * as Redacted from "effect/Redacted";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";
import * as Keys from "./Keys.js";
import * as Source from "./Source.js";

/**
 * What the connections pages say about Pidgeon; the layout around it is every integration's. The
 * connect page is the shared frame, one submit: the key, the inbox's address and what patches may
 * do, each refusal under the field it's about. The key is never written back, so a refused submit
 * asks for it again.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Every sentence the Pidgeon pages say, one place each, so wording changes in one spot. */
export const copy = {
  label: "Pidgeon email",
  offer: "Read and send from one inbox",
  logged:
    "Each call keeps its operation and the ids it named, and a send its subject and recipients; message bodies and search text are never logged.",
  getIt: {
    title: "Make a key in Pidgeon",
    step: "In Pidgeon's dashboard, open API keys and make a key named Patchy: Send if patches will reply and send, Read if they only read.",
    note: "A Test key keeps all mail inside Pidgeon."
  },
  paste: "Paste the key",
  key: {
    label: "Key",
    hint: "Encrypted, and never shown again."
  },
  inbox: {
    label: "Inbox",
    hint: "The address patches read. Make it in Pidgeon first.",
    placeholder: "support@your-domain.example",
    missing: "Type the inbox's address, as Pidgeon shows it."
  },
  access: {
    label: "Patches may",
    read: "Read",
    send: "Read and send",
    hint: "Read and send needs a Send key.",
    missing: "Choose what patches may do: Read, or Read and send."
  },
  name: { example: "support", describe: "The support desk's inbox" },
  once: {
    reads: "this inbox's mail",
    also: "With Read and send, patches reply and send from it, as the person using the patch",
    cannot: [
      "What builders' agents send while they build goes nowhere",
      "Patches can't reach the account's other inboxes"
    ],
    caveat: "The key reaches your whole Pidgeon account. To cut Patchy off, revoke it in Pidgeon."
  },
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
    consequence: (email: string) =>
      `Patchy checks the new key reaches ${email} and can do what patches may, then saves it with a fresh snapshot. Revoke the old key in Pidgeon afterwards.`,
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
    pidgeon_new_key_cant_send: "Read and send needs a Send key",
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
  access === "send" ? copy.access.send : copy.access.read;

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

/** Refusals about the key, the inbox or what patches may do, shown under the field they're about. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["pidgeon_key_rejected", "key"],
  ["pidgeon_new_key_cant_send", "key"],
  ["pidgeon_other_account", "key"],
  ["pidgeon_inbox_not_found", "address"],
  ["pidgeon_no_inbox", "address"],
  ["pidgeon_key_cant_send", "access"],
  ["pidgeon_stored_key_cant_send", "access"]
]);
/** A refusal's bold first line, where the message reads as its explanation. */
export const refusalTitles: ReadonlyMap<string, string> = new Map(
  Object.entries(copy.refusalTitles)
);

// ---------- connecting ----------

/** The key, as connect and Replace key ask for it. */
const keyField: Fields.Spec = {
  kind: "secret",
  name: "key",
  field: "key",
  label: copy.key.label,
  hint: copy.key.hint,
  autocomplete: "new-password"
};

/** What patches may do, as connect and Change access ask for it. */
const accessField: Fields.Spec = {
  kind: "select",
  name: "access",
  field: "access",
  label: copy.access.label,
  hint: copy.access.hint,
  choices: [
    { value: "read", label: copy.access.read },
    { value: "send", label: copy.access.send }
  ],
  initial: "read",
  width: "sm"
};

/** What the connect page asks for, in the shared frame: the key, the inbox and what patches may do. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: { title: copy.getIt.title, steps: [copy.getIt.step], note: copy.getIt.note },
  paste: {
    title: copy.paste,
    fields: [
      keyField,
      {
        kind: "text",
        name: "address",
        field: "address",
        label: copy.inbox.label,
        hint: copy.inbox.hint,
        placeholder: copy.inbox.placeholder,
        maxlength: 320,
        exact: true
      },
      accessField
    ]
  },
  name: copy.name,
  once: {
    reads: copy.once.reads,
    devReads: true,
    also: [copy.once.also],
    cannot: copy.once.cannot,
    caveat: copy.once.caveat
  }
};

export const rotate = {
  title: copy.rotate.title,
  consequence: (connection: ConnectionStore.Connection) =>
    copy.rotate.consequence(
      connection.integration === "pidgeon" ? connection.display.email : "its inbox"
    ),
  submit: copy.rotate.submit,
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.render(keyField, submitted, refusal, true),
  shows: ["key"]
} as const;
export const access = {
  title: copy.change.title,
  consequence: copy.change.consequence,
  submit: copy.change.submit,
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.render(accessField, submitted, refusal),
  shows: ["access"],
  initial: (connection: ConnectionStore.Connection) =>
    connection.integration === "pidgeon" ? { access: connection.display.access } : {}
} as const;

const refused = (field: View.Field, message: string): View.Notice => ({
  message,
  code: "invalid_credentials",
  status: 422,
  field
});

/**
 * What an admin submitted as one secret, or the refusal at the field that stops it, in the order
 * the form asks: the key, the inbox's address, what patches may do. Connect takes all three;
 * Replace key only a key; Change access only the access.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  const access = form.access;
  if (current !== undefined && form.key === undefined) {
    if (access !== "read" && access !== "send") return refused("access", copy.access.missing);
    return Keys.changeSecret({ access });
  }
  const key = (form.key ?? "").trim();
  // Pidgeon itself says whether a key of the right shape is one it accepts.
  if (!Source.isToken(key)) return refused("key", new Keys.InvalidKey({}).message);
  if (current !== undefined) return Keys.changeSecret({ key });
  const email = (form.address ?? "").trim();
  if (email === "" || email.length > 320) return refused("address", copy.inbox.missing);
  if (access !== "read" && access !== "send") return refused("access", copy.access.missing);
  return Keys.connectSecret({ key, email, access });
};
