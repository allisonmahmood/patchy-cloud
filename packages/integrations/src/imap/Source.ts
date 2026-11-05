import { ImapPort, ImapSecurity, type ImapSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { ImapFlow } from "imapflow";

/**
 * One IMAP mailbox, read through a login an admin typed: host, port, security, username and
 * password. The password goes only to that host, at an address Patchy resolved and checked, over
 * TLS 1.2 or later with a certificate that names the host. There's no autodiscovery, no fallback
 * host, and a referral is never followed. Every session resolves and checks again.
 *
 * A login the server refuses pauses the connection (`Display.paused`): nothing logs in again
 * until an admin's Test or Replace password succeeds, because repeated failures make mail hosts
 * refuse the addresses Patchy connects from, and those addresses are shared.
 */

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

/**
 * A mail server's name, as an admin types it: a DNS name with at least one dot, lowercased,
 * never an address. The certificate must name it.
 */
export const Host = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  )
);
/** A login name, often the whole address. No control characters. */
export const Username = Schema.String.check(Schema.isPattern(/^[^\x00-\x1f\x7f]{1,320}$/));
/** A password or app password. No NUL, CR or LF: IMAP can't carry them in a login. */
export const Password = Schema.String.check(Schema.isPattern(/^[^\x00\r\n]{1,1024}$/));

/**
 * What the ciphertext holds: where the password may go, bound with it, so a changed display
 * can never send it elsewhere.
 */
export const Credentials = Schema.Struct({
  host: Host,
  port: ImapPort,
  security: ImapSecurity,
  username: Username,
  password: Password
});
export type Credentials = typeof Credentials.Type;

/** The server's answers to a login that pause a connection: a NO with one of these, or none. */
export const pausingReplies = ["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED"] as const;
export const PausingReply = Schema.Literals(pausingReplies);

/**
 * A login the mail server refused, recorded on the connection: when, what it answered (null for a
 * NO without a code), and whose login it was, an admin's Test, Refresh or Reconnect (`by`) or a
 * patch's call. While it's set nothing logs in, until a Test or Replace password succeeds.
 */
export const Paused = Schema.Struct({
  at: Schema.String,
  reply: Schema.NullOr(PausingReply),
  during: Schema.Literals(["test", "refresh", "reconnect", "call"]),
  by: Schema.optionalKey(Schema.String)
});
export type Paused = typeof Paused.Type;

/** Safe to show: where the connection logs in, as who, and whether it's paused. */
export const Display = Schema.Struct({
  host: Host,
  port: ImapPort,
  security: ImapSecurity,
  username: Username,
  paused: Schema.optionalKey(Paused)
});
export type Display = typeof Display.Type;

// ---------- refusals, each naming the requirement a mailbox missed ----------

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "ImapInvalidCredentials",
  {
    field: Schema.Literals(["host", "port", "security", "username", "password"]),
    cause: Schema.optionalKey(SecretCause)
  }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return {
      host: "Type the mail server's name, such as imap.example.com, not its address.",
      port: "Patchy logs in on port 993 with TLS, or on 143 with STARTTLS.",
      security: "Choose TLS for port 993, or STARTTLS for 143.",
      username: "Type the username the mail server knows, often the whole address.",
      password: "Type the mailbox's password or app password."
    }[this.field];
  }
}
/** The host's name doesn't resolve to any address. */
export class HostNotFound extends Schema.TaggedError<HostNotFound>()("ImapHostNotFound", {
  host: Schema.String,
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "imap_host_not_found";
  readonly status = 422;
  override get message() {
    return `${this.host} doesn't resolve to an address. Check the mail server's name in your mail settings.`;
  }
}
/** One of the host's addresses isn't on the public internet. */
export class PrivateAddress extends Schema.TaggedError<PrivateAddress>()("ImapPrivateAddress", {
  host: Schema.String,
  address: Schema.String
}) {
  readonly code = "imap_private_address";
  readonly status = 422;
  override get message() {
    return `${this.host} resolves to ${this.address}, which isn't a public address. Patchy connects only to mail servers reachable from the internet.`;
  }
}
/** A port other than 993 with TLS or 143 with STARTTLS. */
export class PortNotAllowed extends Schema.TaggedError<PortNotAllowed>()("ImapPortNotAllowed", {
  port: Schema.Number
}) {
  readonly code = "imap_port_not_allowed";
  readonly status = 422;
  override get message() {
    return `Patchy logs in on port 993 with TLS, or on 143 with STARTTLS, so it doesn't use port ${this.port}.`;
  }
}
/** The TLS handshake failed, or the server offered nothing from TLS 1.2 up. */
export class TlsFailed extends Schema.TaggedError<TlsFailed>()("ImapTlsFailed", {
  host: Schema.String,
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "imap_tls_failed";
  readonly status = 422;
  override get message() {
    return `The TLS handshake with ${this.host} failed. The mail server must offer TLS 1.2 or later.`;
  }
}
/** The certificate isn't from a public authority, or isn't valid now. */
export class CertificateUntrusted extends Schema.TaggedError<CertificateUntrusted>()(
  "ImapCertificateUntrusted",
  { host: Schema.String, reason: Schema.String }
) {
  readonly code = "imap_certificate_untrusted";
  readonly status = 422;
  override get message() {
    return `${this.host}'s certificate isn't one Patchy trusts (${this.reason}). The mail server must present a valid certificate from a public certificate authority.`;
  }
}
/** The certificate is trusted but names other hosts: the names it does carry. */
export class CertificateMismatch extends Schema.TaggedError<CertificateMismatch>()(
  "ImapCertificateMismatch",
  { host: Schema.String, names: Schema.Array(Schema.String) }
) {
  readonly code = "imap_certificate_mismatch";
  readonly status = 422;
  override get message() {
    const names = this.names.slice(0, 10);
    return names.length === 0
      ? `${this.host}'s certificate doesn't name ${this.host}, or any host.`
      : `${this.host}'s certificate doesn't name ${this.host}. It names ${names.join(", ")}${this.names.length > names.length ? ` and ${this.names.length - names.length} more` : ""}. A name reached through your own domain often presents the provider's certificate: type the provider's server name instead.`;
  }
}
/** Port 143 without STARTTLS: Patchy never sends a password unencrypted. */
export class StartTlsUnavailable extends Schema.TaggedError<StartTlsUnavailable>()(
  "ImapStartTlsUnavailable",
  { host: Schema.String }
) {
  readonly code = "imap_starttls_unavailable";
  readonly status = 422;
  override get message() {
    return `${this.host} doesn't offer STARTTLS on port 143, and Patchy never sends a password unencrypted. Use port 993 with TLS if the server has it.`;
  }
}
/** CAPABILITY named neither IMAP4rev1 nor IMAP4rev2; nothing was sent after it. */
export class NotImap4 extends Schema.TaggedError<NotImap4>()("ImapNotImap4", {
  host: Schema.String
}) {
  readonly code = "imap_not_imap4";
  readonly status = 422;
  override get message() {
    return `${this.host} doesn't speak IMAP4rev1 or IMAP4rev2, so Patchy didn't log in.`;
  }
}
/** The server won't take a password login at all (LOGINDISABLED and no AUTH=PLAIN). */
export class LoginDisabled extends Schema.TaggedError<LoginDisabled>()("ImapLoginDisabled", {
  host: Schema.String
}) {
  readonly code = "imap_login_disabled";
  readonly status = 422;
  override get message() {
    return `${this.host} has turned off password login. Accounts that need Google or Microsoft sign-in can't connect this way; a host with app passwords takes one here.`;
  }
}
/**
 * The mail server refused the username and password at login: a NO answering LOGIN or
 * AUTHENTICATE, with `reply` its code or null for none. A connection's own login refused this way
 * pauses it.
 */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()("ImapLoginRefused", {
  host: Schema.String,
  reply: Schema.NullOr(PausingReply)
}) {
  readonly code = "auth_failed";
  readonly status = 422;
  override get message() {
    return this.reply === "EXPIRED"
      ? `${this.host} refused the login: the password has expired. Set a new one with the mail host, then replace it here.`
      : `${this.host} refused this username and password. Check both, or make an app password if the host has them.`;
  }
}
/** A paused connection: nothing was sent to the mail server. */
export class ConnectionPaused extends Schema.TaggedError<ConnectionPaused>()(
  "ImapConnectionPaused",
  { at: Schema.String }
) {
  readonly code = "auth_failed";
  readonly status = 409;
  override get message() {
    return "This connection is paused: its mail server refused the password, so Patchy stopped logging in. An admin can Test it or replace the password at /company/connections.";
  }
}
/** Logged in, but EXAMINE INBOX was refused. */
export class NoInbox extends Schema.TaggedError<NoInbox>()("ImapNoInbox", {
  host: Schema.String
}) {
  readonly code = "imap_no_inbox";
  readonly status = 422;
  override get message() {
    return `Patchy logged in to ${this.host}, but the mailbox has no INBOX it could open.`;
  }
}
/**
 * The mail server answered a login with a refusal that isn't about the password, or couldn't be
 * reached or kept talking. `reply` is its response code where it gave one, such as UNAVAILABLE,
 * LIMIT or REFERRAL, or BAD for a rejected command. A referral is never followed.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("ImapUnavailable", {
  host: Schema.String,
  stage: Schema.Literals(["connect", "greeting", "login", "list", "examine", "session"]),
  reply: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "source_unavailable";
  readonly status = 503;
  override get message() {
    switch (this.reply) {
      case "REFERRAL":
        return `${this.host} tried to send Patchy to another server. Patchy logs in only at the host you typed: type the server it named instead.`;
      case "LIMIT":
        return `${this.host} has too many connections open for this mailbox. Try again shortly.`;
      case "UNAVAILABLE":
        return `${this.host} can't log this mailbox in right now. Try again shortly.`;
      case "BAD":
        return `${this.host} rejected Patchy's ${this.stage === "login" ? "login" : "command"} as malformed.`;
      default:
        return `${this.host} couldn't be reached or closed the connection${this.stage === "connect" ? "" : ` during ${this.stage}`}. Try again.`;
    }
  }
}
/** The mail server is limiting this login for now. Never retried. */
export class Throttled extends Schema.TaggedError<Throttled>()("ImapThrottled", {
  host: Schema.String
}) {
  readonly code = "source_rate_limited";
  readonly status = 429;
  override get message() {
    return `${this.host} is limiting logins from Patchy for now. Try again later.`;
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("ImapTimeout", {
  host: Schema.String,
  milliseconds: Schema.Int
}) {
  readonly code = "timeout";
  readonly status = 504;
  override get message() {
    return `${this.host} didn't finish answering within ${this.milliseconds / 1_000} seconds.`;
  }
}
/** The mail server sent more than a session's bounds allow; the session was destroyed. */
export class Overflow extends Schema.TaggedError<Overflow>()("ImapOverflow", {
  host: Schema.String,
  limitId: Schema.Literals([
    "imap.session.bytes",
    "imap.parser.line",
    "imap.parser.literal",
    "imap.parser.response"
  ])
}) {
  readonly code = "too_large";
  readonly status = 413;
  override get message() {
    return `${this.host} sent more than Patchy reads (${registry[this.limitId].measure.split(";")[0]}).`;
  }
}

/** What opening a session refuses, before or at login. */
export type OpenError =
  | HostNotFound
  | PrivateAddress
  | PortNotAllowed
  | TlsFailed
  | CertificateUntrusted
  | CertificateMismatch
  | StartTlsUnavailable
  | NotImap4
  | LoginDisabled
  | LoginRefused
  | Unavailable
  | Throttled
  | Timeout
  | Overflow;
/** What Test, connecting, Replace password and Refresh folders refuse. */
export type InspectError = OpenError | NoInbox | InvalidCredentials;

/** A login's settings, the password redacted. */
export interface Settings {
  readonly host: string;
  readonly port: ImapPort;
  readonly security: ImapSecurity;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}
export const settings = (credentials: Credentials): Settings => ({
  ...credentials,
  password: Redacted.make(credentials.password)
});

export class Source extends Context.Service<
  Source,
  {
    /**
     * Test, on a fresh session, never a pooled one: TLS, CAPABILITY, login, LIST, EXAMINE INBOX,
     * then LOGOUT. Answers the snapshot that session saw. Every refusal names the requirement.
     */
    readonly inspect: (settings: Settings) => Effect.Effect<ImapSnapshot, InspectError>;
    /**
     * A fresh, logged-in session, closed with its scope: resolved and checked again, TLS verified
     * against the typed host, capabilities checked before the password is sent. Its parser and
     * byte bounds destroy it when passed.
     */
    readonly open: (settings: Settings) => Effect.Effect<ImapFlow, OpenError, Scope.Scope>;
  }
>()("@patchy/integrations/imap/Source") {}
