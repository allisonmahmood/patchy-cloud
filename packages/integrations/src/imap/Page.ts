import type { ImapSnapshot } from "@patchy/api";
import { ago, escapeAttribute, escapeHtml } from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Source from "./Source.js";

/**
 * What the connections pages say about an IMAP mailbox; the layout around it is every
 * integration's. A plain form on the shared components while the connect form's and connection
 * page's own design is chosen: host, port, security, username and password, with the
 * requirements and who reads the mailbox above it. The password is typed into this page only and
 * never written back.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "imap" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

export const integration = { key: "imap", label: "Email (IMAP)" } as const;
export const offer = {
  integration,
  reads: "A mailbox's folders, messages and attachments, read-only, through its IMAP login.",
  mode: "Company-wide · read-only"
};
export const actions: View.Actions = { refresh: "Refresh folders", rotate: "Replace password" };
export const results = {
  connect: "Mailbox connected and its folders listed.",
  test: "Mailbox tested: TLS, login, its folders and INBOX all answered.",
  rotate: (connection: ConnectionStore.Connection) =>
    connection.status === "connected"
      ? "Password replaced and tested. Patches keep reading the same mailbox."
      : "Password replaced and tested. The connection stays disconnected until you Reconnect.",
  refresh:
    "Folders refreshed. Existing patches keep their pinned folders; regenerate before publishing against the new ones.",
  reconnect: "Mailbox tested and reconnected. Its snapshot revision is unchanged."
};

const security = (value: Source.Display["security"]) => (value === "tls" ? "TLS" : "STARTTLS");

/** The label beside a paused connection's name, on the index and its page. */
export const tag = (connection: Connection) =>
  connection.display.paused === undefined ? undefined : "Paused · password refused";
export const source = (connection: Connection) =>
  `${connection.display.username} at ${connection.display.host}`;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  [
    "Server",
    `${connection.display.host}, port ${connection.display.port} (${security(connection.display.security)})`
  ],
  ["Username", connection.display.username]
];

const whose = { test: "Test", refresh: "Refresh", reconnect: "Reconnect" } as const;
/**
 * A paused connection, until a Test or Replace password logs in: whose login the server refused,
 * when, and the way out.
 */
export const standing = (
  connection: Connection,
  people: ReadonlyMap<string, string>,
  now: number
): ReadonlyArray<View.Standing> => {
  const paused = connection.display.paused;
  if (paused === undefined) return [];
  const who =
    paused.during === "call"
      ? "A patch's call"
      : `${(paused.by === undefined ? undefined : people.get(paused.by)) ?? "An admin"}'s ${whose[paused.during]}`;
  return [
    {
      tone: "refused",
      title: "Paused: the mail server refused the password",
      text: `${who}, ${ago(paused.at, now)}, was refused at login${paused.reply === null ? "" : ` (${paused.reply})`}. Patchy stopped logging in, so the mail host doesn't block the addresses Patchy connects from. Patches that declare imap/${connection.handle} fail until a Test or a new password logs in.`,
      actions: [
        {
          href: View.connectionPath(connection.id, "test"),
          label: "Test",
          primary: true,
          post: true
        },
        { href: View.connectionPath(connection.id, "rotate"), label: "Replace password…" }
      ]
    }
  ];
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const SHOWN = 8;

/** "12 folders.", then the first folders by path. */
export const reads = (snapshot: ImapSnapshot) => ({
  summary: `${plural(snapshot.folders.length, "folder")}${snapshot.truncated ? ", and more the snapshot doesn't keep" : ""}. Patches read their messages and attachments, never changing them.`,
  items: snapshot.folders.slice(0, SHOWN).map((folder) => folder.path),
  more: Math.max(0, snapshot.folders.length - SHOWN)
});

export const consequences = {
  disconnect:
    "Patches that declare it can't read the mailbox until an admin reconnects it. What they already imported stays in each patch. Reconnecting logs in again first."
};

// ---------- connecting ----------

export const connectIntro =
  "From your mail settings: the IMAP server, its port and security, the username and the password. Connecting logs in once on a fresh session to check everything before anything is saved.";

const requirements = `<div class="note"><strong class="note-title">The mailbox must</strong><ul class="list list-compact"><li class="list-row">speak IMAP4rev1 or IMAP4rev2 over TLS 1.2 or later, on port 993, or on 143 with STARTTLS;</li><li class="list-row">present a certificate from a public authority that names the host you type;</li><li class="list-row">take a username and password, or an app password where the host has them;</li><li class="list-row">be reachable from the internet at a public address, without an IP allowlist.</li></ul><p>Accounts that need Google or Microsoft sign-in can't connect this way.</p></div>`;
const audience = `<div class="note note-warn"><strong class="note-title">Who reads this mailbox</strong><p>Every member reads the whole mailbox through any patch that declares it, and so do the patch's guests unless you block guests on the connection's page. While someone builds a patch with it, their agent reads the real mailbox through Patchy, as them. Use a shared or dedicated mailbox, not a person's own.</p><p>Patchy only reads: it never sends, moves, deletes or marks mail as read. The password itself isn't read-only. What patches import stays in each patch after a disconnect, and nothing refreshes on its own.</p></div>`;

const passwordField = (refusal: View.Notice | undefined, label = "Password") => {
  const note = View.fieldNote(
    "connection-password",
    "password",
    "Or an app password. Patchy encrypts it and never shows it again.",
    refusal
  );
  return `<label class="field-label" for="connection-password">${escapeHtml(label)}</label><input class="field" id="connection-password" type="password" name="password" required maxlength="1024" autocomplete="new-password" spellcheck="false"${note.attributes}>${note.note}`;
};

const loginFields = (submitted: Submitted, refusal: View.Notice | undefined) => {
  const host = View.fieldNote(
    "connection-host",
    "host",
    "The IMAP server's name, such as imap.example.com.",
    refusal
  );
  const port = View.fieldNote(
    "connection-port",
    "port",
    "993 with TLS, or 143 with STARTTLS.",
    refusal
  );
  const mode = View.fieldNote(
    "connection-security",
    "security",
    "TLS for 993, STARTTLS for 143.",
    refusal
  );
  const username = View.fieldNote(
    "connection-username",
    "username",
    "Often the whole address.",
    refusal
  );
  const chosen = submitted.port === "143" ? "143" : "993";
  const secured =
    submitted.security === "starttls" ? "starttls" : chosen === "143" ? "starttls" : "tls";
  return `<label class="field-label" for="connection-host">Server</label><input class="field" id="connection-host" name="host" value="${escapeAttribute(submitted.host ?? "")}" required maxlength="253" autocomplete="off" autocapitalize="none" spellcheck="false"${host.attributes}>${host.note}<label class="field-label" for="connection-port">Port</label><select class="field" id="connection-port" name="port"${port.attributes}>${["993", "143"].map((value) => `<option value="${value}"${chosen === value ? " selected" : ""}>${value}</option>`).join("")}</select>${port.note}<label class="field-label" for="connection-security">Security</label><select class="field" id="connection-security" name="security"${mode.attributes}>${(["tls", "starttls"] as const).map((value) => `<option value="${value}"${secured === value ? " selected" : ""}>${security(value)}</option>`).join("")}</select>${mode.note}<label class="field-label" for="connection-username">Username</label><input class="field" id="connection-username" name="username" value="${escapeAttribute(submitted.username ?? "")}" required maxlength="320" autocomplete="off" autocapitalize="none" spellcheck="false"${username.attributes}>${username.note}${passwordField(refusal)}`;
};

/** Refusals about the login, shown under the field they're about rather than atop the page. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["imap_host_not_found", "host"],
  ["imap_private_address", "host"],
  ["imap_tls_failed", "host"],
  ["imap_certificate_untrusted", "host"],
  ["imap_certificate_mismatch", "host"],
  ["imap_not_imap4", "host"],
  ["imap_preauth", "host"],
  ["imap_port_not_allowed", "port"],
  ["imap_starttls_unavailable", "port"],
  ["imap_login_disabled", "username"],
  ["imap_no_inbox", "username"],
  ["auth_failed", "password"]
]);
export const refusalTitles: ReadonlyMap<string, string> = new Map([
  ["imap_certificate_mismatch", "The certificate names another server"],
  ["auth_failed", "The mail server refused the login"]
]);

/** The connect form's fields; a refused submit keeps everything typed except the password. */
export const connectFields = (submitted: Submitted, refusal?: View.Notice) => {
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "Patches use this name, which can't be changed later.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line on what this mailbox holds, so builders pick the right one.",
    refusal
  );
  return `${requirements}<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">imap/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${loginFields(submitted, refusal)}${audience}`;
};

export const rotate = {
  title: (name: string) => `Replace the password for ${name}`,
  consequence: (connection: ConnectionStore.Connection) =>
    `Patchy logs in with the new password on a fresh session before saving it${connection.integration === "imap" ? `, as ${connection.display.username} at ${connection.display.host}` : ""}. A paused connection is unpaused once it works.`,
  fields: (_submitted: Submitted, refusal?: View.Notice) => passwordField(refusal, "New password")
};

const refused = (field: Source.InvalidCredentials["field"]): View.Notice => ({
  message: new Source.InvalidCredentials({ field }).message,
  code: "invalid_credentials",
  status: 422,
  field
});
const isHost = Schema.is(Source.Host);
const isUsername = Schema.is(Source.Username);
const isPassword = Schema.is(Source.Password);

/**
 * The submitted login as one secret, or the refusal at the field that stops it. Replace password
 * keeps the connection's host, port, security and username, and takes only the new password.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  const kept = current?.integration === "imap" ? current.display : undefined;
  const host = kept?.host ?? (form.host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const port = kept?.port ?? Number(form.port);
  const mode = kept?.security ?? form.security;
  const username = kept?.username ?? (form.username ?? "").trim();
  const password = form.password ?? "";
  if (!isHost(host)) return refused("host");
  if (port !== 993 && port !== 143) return refused("port");
  const expected = port === 993 ? "tls" : "starttls";
  if (mode !== expected) return refused("security");
  if (!isUsername(username)) return refused("username");
  if (!isPassword(password)) return refused("password");
  return Source.credentials({ host, port, security: expected, username, password });
};

/** Layout only: none of its own yet. */
export const styles = "";
