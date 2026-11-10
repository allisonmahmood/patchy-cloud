import type { ImapSnapshot } from "@patchy/api";
import { ago, escapeAttribute, escapeHtml } from "@patchy/core";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";
import * as Source from "./Source.js";

/**
 * What the connections pages say about an IMAP mailbox; the layout around it is every
 * integration's. The connect page is the shared form inside a walkthrough: what a mailbox needs,
 * then its login (one choice for port and security, which follows the port), then using it. The
 * password is typed into this page only and never written back. The connection page names the
 * server and username, counts the folders, and keeps a refused login's way out on top.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "imap" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

export const integration = { key: "imap", label: "Email (IMAP)", mark: "@" } as const;
export const offer = { integration, line: "A mailbox's messages and attachments" };
export const actions: View.Actions = { refresh: "Refresh folders", rotate: "Replace password" };
export const results = {
  connect: "Mailbox connected and its folders listed.",
  test: "Mailbox tested: it logged in, listed its folders and opened INBOX.",
  rotate: (connection: ConnectionStore.Connection) =>
    connection.status === "connected"
      ? "Password replaced and tested. Patches keep reading the same mailbox."
      : "Password replaced and tested. The connection stays paused until you resume it.",
  refresh:
    "Folders refreshed. Existing patches keep their pinned folders; regenerate before publishing against the new ones.",
  reconnect: "Mailbox tested and resumed. Its snapshot revision is unchanged."
};
/** What recent calls keep of an IMAP call, an attachment's stage included. */
export const logged =
  "Each call keeps its operation, who made it, when, how long it took and how much it read: rows, or an attachment's size. Subjects, bodies, addresses, search values, attachment filenames and upload tokens are never logged.";

/** The port choice, which decides the security too: 993 opens TLS at once, 143 starts it. */
const ports = [
  { port: 993, security: "tls", label: "993 (TLS)" },
  { port: 143, security: "starttls", label: "143 (STARTTLS)" }
] as const;

export const source = (connection: Connection) =>
  `${connection.display.username} at ${connection.display.host}`;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  [
    "Server",
    `${connection.display.host}, port ${ports.find((item) => item.port === connection.display.port)?.label ?? connection.display.port}`
  ],
  ["Username", connection.display.username]
];
/** What it holds, as Settings names it: the password, never shown, and whose login it is. */
export const credential = (connection: Connection) => ({
  label: "Password",
  detail: `Stored · for ${connection.display.username}`
});

const whose = { test: "Test", refresh: "Refresh", reconnect: "Resume" } as const;
/**
 * A login the mail server refused, until a Test or Replace password logs in: whose login it was,
 * when, and the two ways out. Patchy stops logging in meanwhile, its login pause, which the pages
 * call Needs attention: Paused is what an admin does, and stays separate, since an admin's pause
 * changes the connection's status and the login pause doesn't.
 */
export const attention = (
  connection: Connection,
  people: ReadonlyMap<string, string>,
  now: number
): View.Attention | undefined => {
  const paused = connection.display.paused;
  if (paused === undefined) return undefined;
  const who =
    paused.during === "call"
      ? "a patch's call"
      : `${(paused.by === undefined ? undefined : people.get(paused.by)) ?? "an admin"}'s ${whose[paused.during]}`;
  return {
    tone: "danger",
    title: "The mail server refused the password",
    text: `It refused ${who} ${ago(paused.at, now)}${paused.reply === null ? "" : ` (${paused.reply})`}. Patchy stopped logging in so the mail host won't block it, and calls stop until Test or Replace password succeeds.`,
    fixes: [
      {
        href: View.connectionPath(connection.id, "rotate"),
        label: "Replace password…",
        primary: true
      },
      { href: View.connectionPath(connection.id, "test"), label: "Test again", post: true }
    ]
  };
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const SHOWN = 5;

/** "13 folders.", then the first folders by path. */
export const reads = (snapshot: ImapSnapshot) => ({
  summary: `${plural(snapshot.folders.length, "folder")}${snapshot.truncated ? ", and more the snapshot doesn't keep" : ""}.`,
  items: snapshot.folders.slice(0, SHOWN).map((folder) => folder.path),
  more: Math.max(0, snapshot.folders.length - SHOWN)
});

export const consequences = {
  disconnect:
    "Patches that declare it can't read the mailbox until an admin resumes it. What they already imported stays in each patch. Resuming logs in again first."
};

// ---------- connecting ----------

export const connectIntro =
  "Nothing is saved until Patchy has logged in to the mailbox and listed its folders.";

const requirements = [
  "IMAP over TLS 1.2 or later, on port 993, or 143 with STARTTLS",
  "A certificate from a public authority naming the host you type",
  "A username and password, or an app password",
  "An address reachable from the internet, with no IP allowlist"
];
export const walkthrough: View.Walkthrough = {
  before: [
    {
      title: "Get a login for the mailbox",
      text: "Patchy works with a mailbox that has:",
      detail: `<ul class="list list-compact">${requirements.map((item) => `<li class="list-row">${escapeHtml(item)}</li>`).join("")}</ul><p>Accounts that need Google or Microsoft sign-in can't connect this way.</p>`
    }
  ],
  current: "Fill it in",
  after: [
    {
      title: "Use it in a patch",
      text: "Ask your agent to add it to a patch by its name, such as imap/invoices."
    }
  ]
};

const access = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member reads the whole mailbox through any patch that declares it, and so do its guests unless you block guests on the connection's page. Patchy only reads, so use a shared or dedicated mailbox, not a person's own.</p></div>`;

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
    "From your mail settings; the security follows the port.",
    refusal
  );
  const username = View.fieldNote(
    "connection-username",
    "username",
    "Often the whole address.",
    refusal
  );
  const chosen = submitted.port === "143" ? 143 : 993;
  return `<label class="field-label" for="connection-host">Server</label><input class="field" id="connection-host" name="host" value="${escapeAttribute(submitted.host ?? "")}" required maxlength="253" autocomplete="off" autocapitalize="none" spellcheck="false"${host.attributes}>${host.note}<label class="field-label" for="connection-port">Port</label><select class="field" id="connection-port" name="port"${port.attributes}>${ports.map((item) => `<option value="${item.port}"${item.port === chosen ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select>${port.note}<label class="field-label" for="connection-username">Username</label><input class="field" id="connection-username" name="username" value="${escapeAttribute(submitted.username ?? "")}" required maxlength="320" autocomplete="off" autocapitalize="none" spellcheck="false"${username.attributes}>${username.note}${passwordField(refusal)}`;
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
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">imap/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${loginFields(submitted, refusal)}${access}`;
};

/** The password, as Replace password asks for it. */
const newPassword: Fields.Spec = {
  kind: "secret",
  name: "password",
  field: "password",
  label: "New password",
  hint: "Or an app password.",
  autocomplete: "new-password",
  maxlength: 1024
};

export const rotate = {
  title: (name: string) => `Replace the password for ${name}`,
  consequence: (connection: ConnectionStore.Connection) =>
    `Patchy logs in${connection.integration === "imap" ? ` to ${connection.display.host} as ${connection.display.username}` : ""} with the new password before saving it. If it works, Patchy logs in with it again.`,
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.render(newPassword, submitted, refusal, true),
  shows: ["password"]
} as const;

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
 * The submitted login as one secret, or the refusal at the field that stops it. The form's one
 * port choice decides the security; a `security` sent beside it must agree. Replace password
 * keeps the connection's host, port, security and username, and takes only the new password.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  const kept = current?.integration === "imap" ? current.display : undefined;
  const host = kept?.host ?? (form.host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const choice = ports.find((item) => item.port === (kept?.port ?? Number(form.port)));
  const username = kept?.username ?? (form.username ?? "").trim();
  const password = form.password ?? "";
  if (!isHost(host)) return refused("host");
  if (choice === undefined) return refused("port");
  // The form has no security control: the port choice carries it, so a refusal sits there.
  if (kept === undefined && form.security !== undefined && form.security !== choice.security)
    return {
      ...refused("security"),
      message: "The security follows the port: 993 opens TLS, and 143 starts it with STARTTLS.",
      field: "port"
    };
  if (!isUsername(username)) return refused("username");
  if (!isPassword(password)) return refused("password");
  return Source.credentials({
    host,
    port: choice.port,
    security: choice.security,
    username,
    password
  });
};

/** Layout only: none of its own. */
export const styles = "";
