// @effect-diagnostics nodeBuiltinImport:off -- TLS sockets, certificate checks and IP classification are the native transport boundary.
import { connect as connectTcp, isIP, type Socket } from "node:net";
import {
  checkServerIdentity,
  connect as connectTls,
  type PeerCertificate,
  rootCertificates,
  type TLSSocket
} from "node:tls";
import {
  ImapPort,
  ImapSecurity,
  type ImapFolder,
  type ImapSnapshot,
  imapSpecialUses
} from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ImapFlow, type ImapFlowError, type ImapTransport, type ListResponse } from "imapflow";
import * as Network from "./Network.js";

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

/**
 * Safe to show: where the connection logs in, as who, and whether it's paused. `logins` counts the
 * logins that worked and were saved, from connect, Test, Replace password, Refresh folders and
 * Reconnect (absent is none): a login attempt carries the count it started under, and its refusal
 * pauses the connection only if no login has worked since.
 */
export const Display = Schema.Struct({
  host: Host,
  port: ImapPort,
  security: ImapSecurity,
  username: Username,
  logins: Schema.optionalKey(Schema.Int),
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
/**
 * The server greeted with PREAUTH: it logged Patchy in without asking for the password, so the
 * password typed could never be checked. Nothing was sent after the greeting's own commands.
 */
export class Preauthenticated extends Schema.TaggedError<Preauthenticated>()(
  "ImapPreauthenticated",
  { host: Schema.String }
) {
  readonly code = "imap_preauth";
  readonly status = 422;
  override get message() {
    return `${this.host} logged Patchy in without a password (PREAUTH), so the password you typed can't be checked. Patchy connects only to mail servers that ask for the mailbox's password.`;
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
    return "This connection is paused: its mail server refused the password, so Patchy stopped logging in. An admin can Test it or replace the password at /settings/integrations.";
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
    "imap.call.bytes",
    "imap.parser.line",
    "imap.parser.literal",
    "imap.parser.response"
  ])
}) {
  readonly code = "too_large";
  readonly status = 413;
  override get message() {
    const what = {
      "imap.session.bytes": "in one session",
      "imap.call.bytes": "for one call",
      "imap.parser.line": "in one line",
      "imap.parser.literal": "in one literal",
      "imap.parser.response": "in one response"
    }[this.limitId];
    return `${this.host} sent more than the ${registry[this.limitId].default.toLocaleString("en-US")} bytes Patchy reads ${what}, so Patchy closed the session.`;
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
  | Preauthenticated
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

/**
 * What a session counts the bytes it receives against: past `limit` its socket is destroyed and
 * `overflow` names `limitId`, as it names a parser bound the session passed. A session opened
 * without one counts against `imap.session.bytes`; the pool passes its own and re-arms it for
 * each call it lends the session to.
 */
export interface Meter {
  received: number;
  limit: number;
  limitId: Overflow["limitId"];
  overflow?: Overflow["limitId"];
}

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
    readonly open: (
      settings: Settings,
      meter?: Meter
    ) => Effect.Effect<ImapFlow, OpenError, Scope.Scope>;
  }
>()("@patchy/integrations/imap/Source") {}

// ---------- one session's mechanics ----------

declare module "imapflow" {
  interface ImapFlow {
    /** ImapFlow's own login step, run once CAPABILITY and STARTTLS are done. */
    authenticate(): Promise<boolean>;
    /** ImapFlow's handler for a PREAUTH greeting, which it takes as already logged in. */
    initialPREAUTH(): Promise<void>;
  }
}

/** How far a session got, and what stopped it: the classifier reads only this. */
interface Progress {
  /** The TCP connection to the checked address opened. */
  connected: boolean;
  /** The TLS handshake finished, at once on 993 or after STARTTLS on 143. */
  secured: boolean;
  /** What broke the handshake, and the names a trusted certificate carried instead of the host. */
  tlsError?: unknown;
  mismatch?: ReadonlyArray<string>;
  /**
   * CAPABILITY came back without what Patchy needs, or the server greeted PREAUTH, so no login
   * was sent.
   */
  refused?: "not_imap4" | "login_disabled" | "preauth";
  /** LOGIN or AUTHENTICATE was sent, and what it failed with if it did. */
  loginStarted: boolean;
  loginError?: unknown;
  /** A bound the session passed, after which it was destroyed. */
  overflow?: Overflow["limitId"];
  /** Bytes received from the mail server so far. */
  received: number;
}

const parserBounds: Readonly<Record<string, Overflow["limitId"]>> = {
  LineTooLarge: "imap.parser.line",
  LiteralTooLarge: "imap.parser.literal",
  ResponseTooLarge: "imap.parser.response",
  TooManyTokens: "imap.parser.response",
  TooManyResponses: "imap.parser.response"
};

/** The parser bound an ImapFlow error names, when it names one: its session is then broken. */
export const parserBound = (error: unknown): Overflow["limitId"] | undefined =>
  Object.hasOwn(parserBounds, errorCode(error) ?? "") ? parserBounds[errorCode(error)!] : undefined;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const imapError = (error: unknown): ImapFlowError | undefined =>
  error instanceof Error ? error : undefined;

/**
 * ImapFlow with one step added: before LOGIN or AUTHENTICATE, the server must advertise IMAP4rev1
 * or IMAP4rev2 and take a password login at all. A server that doesn't is refused with nothing
 * sent, and any failure once the step begins is the login's, never a later command's. A server
 * that greets PREAUTH is refused too: ImapFlow would skip the login, so the password would never
 * be checked.
 */
class CheckedImapFlow extends ImapFlow {
  readonly #progress: Progress;
  constructor(options: ConstructorParameters<typeof ImapFlow>[0], progress: Progress) {
    super(options);
    this.#progress = progress;
  }
  override async initialPREAUTH() {
    this.#progress.refused = "preauth";
    return super.initialPREAUTH();
  }
  override async authenticate() {
    if (this.#progress.refused === "preauth")
      throw new Error("The server logged in without asking for the password.");
    const capabilities = this.capabilities;
    if (!capabilities.has("IMAP4rev1") && !capabilities.has("IMAP4rev2")) {
      this.#progress.refused = "not_imap4";
      throw new Error("The server advertises neither IMAP4rev1 nor IMAP4rev2.");
    }
    if (
      capabilities.has("LOGINDISABLED") &&
      !capabilities.has("AUTH=PLAIN") &&
      !capabilities.has("AUTH=LOGIN")
    ) {
      this.#progress.refused = "login_disabled";
      throw new Error("The server takes no password login.");
    }
    this.#progress.loginStarted = true;
    try {
      return await super.authenticate();
    } catch (error) {
      this.#progress.loginError = error;
      throw error;
    }
  }
}

/** The DNS names a certificate carries, from its subjectAltName, else its common name. */
export const certificateNames = (certificate: PeerCertificate | undefined): string[] => {
  const names = (certificate?.subjectaltname ?? "")
    .split(/,\s*/)
    .flatMap((entry) => (entry.startsWith("DNS:") ? [entry.slice(4)] : []));
  const common = certificate?.subject?.CN;
  return names.length > 0 ? names : typeof common === "string" && common !== "" ? [common] : [];
};

/**
 * The transport ImapFlow opens its session through: TCP to the checked address only, then TLS 1.2
 * or later with SNI and certificate verification against the typed host, with no switch to skip
 * it. Bytes received count against `budget`; past it the socket is destroyed.
 */
const transport = (input: {
  readonly host: string;
  readonly destination: { readonly address: string; readonly port: number };
  readonly ca: ReadonlyArray<string> | undefined;
  readonly meter: Meter;
  readonly progress: Progress;
}): ImapTransport => {
  const { host, destination, progress } = input;
  const ca = input.ca === undefined ? undefined : [...rootCertificates, ...input.ca];
  let unmeter = () => {};
  const meter = (socket: Socket) => {
    const count = (chunk: Buffer) => {
      progress.received += chunk.byteLength;
      input.meter.received += chunk.byteLength;
      if (input.meter.received > input.meter.limit) {
        progress.overflow ??= input.meter.limitId;
        input.meter.overflow ??= input.meter.limitId;
        socket.destroy(new Error("The IMAP session passed its byte budget."));
      }
    };
    socket.on("data", count);
    unmeter = () => socket.off("data", count);
  };
  const secure = (over: Socket | undefined, onSecure: () => void): TLSSocket => {
    const tls = connectTls({
      ...(over === undefined
        ? { host: destination.address, port: destination.port }
        : { socket: over }),
      servername: host,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }),
      checkServerIdentity: (_name, certificate) => {
        const error = checkServerIdentity(host, certificate);
        if (error !== undefined) progress.mismatch = certificateNames(certificate);
        return error;
      }
    });
    if (over === undefined)
      tls.once("connect", () => {
        progress.connected = true;
      });
    tls.once("error", (error) => {
      if (progress.secured) return;
      progress.tlsError = error;
      // A runtime that checks the name itself reports it by code; the names come from the peer.
      if (progress.mismatch === undefined && errorCode(error) === "ERR_TLS_CERT_ALTNAME_INVALID")
        progress.mismatch = certificateNames(tls.getPeerCertificate());
    });
    tls.once("secureConnect", () => {
      progress.secured = true;
      progress.connected = true;
      onSecure();
      meter(tls);
    });
    return tls;
  };
  return {
    connect: (options, onConnect) => {
      if (options.secure) return secure(undefined, onConnect);
      const socket = connectTcp({ host: destination.address, port: destination.port });
      socket.once("connect", () => {
        progress.connected = true;
        onConnect();
        meter(socket);
      });
      return socket;
    },
    // STARTTLS: the cleartext socket stops being counted, and the TLS socket over it is.
    upgrade: (socket, _options, onSecure) => {
      unmeter();
      return secure(socket as Socket, onSecure);
    }
  };
};

const untrusted: ReadonlyArray<readonly [RegExp, string]> = [
  [/EXPIRED|NOT_YET_VALID/, "it isn't valid now"],
  [/SELF_SIGNED/, "it's self-signed"],
  [/ISSUER|UNABLE_TO_VERIFY|UNTRUSTED/, "its issuer isn't a known authority"],
  [/REVOKED/, "it's been revoked"],
  [/CERT|SIGNATURE/, "it couldn't be verified"]
];

/**
 * Whether a login's failure pauses the connection: a NO answering LOGIN or AUTHENTICATE whose code
 * is AUTHENTICATIONFAILED, AUTHORIZATIONFAILED or EXPIRED, or which has none. Never a BAD, a
 * throttle, another code such as UNAVAILABLE, REFERRAL or LIMIT, or a network failure. ImapFlow's
 * own `authenticationFailed` is never read: it's set for far more than a refused password.
 */
export const pausingReply = (error: unknown): { readonly reply: Paused["reply"] } | undefined => {
  const failure = imapError(error);
  if (failure?.responseStatus !== "NO" || failure.code === "ETHROTTLE") return undefined;
  const reply = failure.serverResponseCode;
  if (reply === undefined) return { reply: null };
  const known = pausingReplies.find((item) => item === reply);
  return known === undefined ? undefined : { reply: known };
};

/** What stopped a session before or at login, as the refusal naming the requirement it missed. */
const classify = (host: string, progress: Progress, error: unknown): OpenError => {
  if (progress.overflow !== undefined) return new Overflow({ host, limitId: progress.overflow });
  const bound = parserBounds[errorCode(error) ?? ""];
  if (bound !== undefined) return new Overflow({ host, limitId: bound });
  if (progress.refused === "preauth") return new Preauthenticated({ host });
  if (progress.refused === "not_imap4") return new NotImap4({ host });
  if (progress.refused === "login_disabled") return new LoginDisabled({ host });
  if (progress.connected && !progress.secured && progress.tlsError !== undefined) {
    if (progress.mismatch !== undefined)
      return new CertificateMismatch({ host, names: progress.mismatch });
    const tlsCode = errorCode(progress.tlsError) ?? "";
    const reason = untrusted.find(([pattern]) => pattern.test(tlsCode));
    if (reason !== undefined && tlsCode !== "ERR_TLS_CERT_ALTNAME_INVALID")
      return new CertificateUntrusted({ host, reason: reason[1] });
    return new TlsFailed({ host, cause: Redacted.make(progress.tlsError) });
  }
  const failure = imapError(error);
  // ImapFlow marks a required STARTTLS it couldn't start, and data injected before the handshake.
  if (!progress.secured && failure !== undefined && "tlsFailed" in failure)
    return errorCode(error) === "STARTTLS_INJECTION"
      ? new TlsFailed({ host, cause: Redacted.make(error) })
      : new StartTlsUnavailable({ host });
  if (progress.loginStarted && progress.loginError !== undefined) {
    const login = imapError(progress.loginError);
    if (login?.code === "ETHROTTLE") return new Throttled({ host });
    const pausing = pausingReply(progress.loginError);
    if (pausing !== undefined) return new LoginRefused({ host, reply: pausing.reply });
    if (login?.responseStatus === "NO" || login?.responseStatus === "BAD")
      return new Unavailable({
        host,
        stage: "login",
        reply: login.responseStatus === "BAD" ? "BAD" : (login.serverResponseCode ?? "NO")
      });
    return new Unavailable({ host, stage: "login", cause: Redacted.make(progress.loginError) });
  }
  const code = errorCode(error);
  return new Unavailable({
    host,
    stage:
      code === "GREETING_TIMEOUT"
        ? "greeting"
        : !progress.connected || code === "CONNECT_TIMEOUT"
          ? "connect"
          : progress.loginStarted
            ? "session"
            : "greeting",
    cause: Redacted.make(error)
  });
};

/** A command's failure after login, at `stage`; a NO there is the caller's to name. */
const afterLogin = (
  host: string,
  progress: Progress,
  stage: "list" | "examine",
  error: unknown
): Overflow | Unavailable => {
  if (progress.overflow !== undefined) return new Overflow({ host, limitId: progress.overflow });
  const bound = parserBounds[errorCode(error) ?? ""];
  if (bound !== undefined) return new Overflow({ host, limitId: bound });
  return new Unavailable({ host, stage, cause: Redacted.make(error) });
};

const capabilityName = /^[\x21-\x7e]{1,128}$/;
const MAX_CAPABILITIES = 256;
const MAX_PATH = 1024;

/** One LIST entry as the snapshot keeps it: only the special-use flags the server sent. */
const folderOf = (entry: ListResponse): ImapFolder => {
  const flags = new Set([...entry.flags].map((flag) => flag.toLowerCase()));
  return {
    path: entry.path,
    delimiter: entry.delimiter === "" ? null : (entry.delimiter ?? null),
    specialUse: imapSpecialUses.filter((flag) => flags.has(flag.toLowerCase())),
    selectable: !flags.has("\\noselect") && !flags.has("\\nonexistent")
  };
};

export const make = Effect.gen(function* () {
  const network = yield* Network.Network;

  /** The address to dial: the host resolves, and every address it resolves to is admitted. */
  const admit = Effect.fn("Imap.admit")(function* (settings: Settings) {
    if (!(
      (settings.port === 993 && settings.security === "tls") ||
      (settings.port === 143 && settings.security === "starttls")
    ))
      return yield* new PortNotAllowed({ port: settings.port });
    const addresses = yield* network
      .resolve(settings.host)
      .pipe(
        Effect.mapError((error) =>
          error.reason === "EAI_AGAIN"
            ? new Unavailable({ host: settings.host, stage: "connect" })
            : new HostNotFound({ host: settings.host })
        )
      );
    if (addresses.length === 0) return yield* new HostNotFound({ host: settings.host });
    const refused = addresses.find((address) => !network.admits(settings.host, address));
    if (refused !== undefined)
      return yield* new PrivateAddress({ host: settings.host, address: refused });
    // IPv4 first, so a host without IPv6 egress still reaches a dual-stack server.
    return [...addresses].sort((a, b) => Number(isIP(a) !== 4) - Number(isIP(b) !== 4))[0]!;
  });

  /** A logged-in session and how it got there, closed with its scope. */
  const session = Effect.fn("Imap.session")(function* (settings: Settings, given?: Meter) {
    const address = yield* admit(settings);
    const bounds = yield* Effect.all({
      connect: ContractLimits.get("imap.session.connect"),
      bytes: ContractLimits.get("imap.session.bytes"),
      line: ContractLimits.get("imap.parser.line"),
      literal: ContractLimits.get("imap.parser.literal"),
      response: ContractLimits.get("imap.parser.response")
    });
    const progress: Progress = {
      connected: false,
      secured: false,
      loginStarted: false,
      received: 0
    };
    const target: Network.Target = { host: settings.host, address, port: settings.port };
    const meter: Meter = given ?? {
      received: 0,
      limit: bounds.bytes,
      limitId: "imap.session.bytes"
    };
    const client = new CheckedImapFlow(
      {
        host: settings.host,
        port: settings.port,
        servername: settings.host,
        secure: settings.security === "tls",
        // STARTTLS is required on 143: a server without it never sees the password.
        ...(settings.security === "starttls" ? { doSTARTTLS: true } : {}),
        auth: { user: settings.username, pass: Redacted.value(settings.password) },
        transport: transport({
          host: settings.host,
          destination: network.destination(target),
          ca: network.ca(settings.host),
          meter,
          progress
        }),
        logger: false,
        clientInfo: { name: "Patchy", vendor: "Patchy", "support-url": "https://patchyhq.com" },
        disableAutoIdle: true,
        disableCompression: true,
        connectionTimeout: bounds.connect,
        greetingTimeout: bounds.connect,
        maxLineLength: bounds.line,
        maxLiteralSize: bounds.literal,
        maxResponseSize: bounds.response
      },
      progress
    );
    // A session's errors arrive as events too; one with no listener would throw.
    client.on("error", (error: unknown) => {
      const bound = parserBounds[errorCode(error) ?? ""];
      if (bound !== undefined) {
        progress.overflow ??= bound;
        meter.overflow ??= bound;
      }
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, OpenError>((resume) => {
        client.connect().then(
          () => resume(Effect.void),
          (error: unknown) => resume(Effect.fail(classify(settings.host, progress, error)))
        );
        return Effect.sync(() => client.close());
      }),
      () =>
        Effect.tryPromise(() => client.logout()).pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => client.close()))
        )
    );
    return { client, progress };
  });

  const open = (settings: Settings, meter?: Meter) =>
    Effect.map(session(settings, meter), ({ client }): ImapFlow => client);

  const inspect = Effect.fn("Imap.inspect")(function* (settings: Settings) {
    const deadline = yield* ContractLimits.get("imap.test.deadline");
    const folders = yield* ContractLimits.get("imap.snapshot.folders");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const { client, progress } = yield* session(settings);
        const capabilities = [...client.capabilities.keys()]
          .filter((name) => capabilityName.test(name))
          .sort()
          .slice(0, MAX_CAPABILITIES);
        const listed = yield* Effect.tryPromise({
          try: () => client.list({ listOnly: true }),
          catch: (error) => afterLogin(settings.host, progress, "list", error)
        });
        yield* Effect.tryPromise({
          try: () => client.mailboxOpen("INBOX", { readOnly: true }),
          catch: (error) =>
            imapError(error)?.responseStatus === "NO"
              ? new NoInbox({ host: settings.host })
              : afterLogin(settings.host, progress, "examine", error)
        });
        const kept = listed.filter((entry) => entry.path.length <= MAX_PATH);
        return {
          version: 1,
          host: settings.host,
          port: settings.port,
          security: settings.security,
          username: settings.username,
          capabilities,
          folders: kept.slice(0, folders).map(folderOf),
          truncated: kept.length > folders || kept.length < listed.length
        } satisfies ImapSnapshot;
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () => Effect.fail(new Timeout({ host: settings.host, milliseconds: deadline }))
      })
    );
  });

  return Source.of({ inspect, open });
});

/** Needs the network from whoever launches it: production's, or dev's and tests' loopback. */
export const layer = Layer.effect(Source, make);

const credentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
const encodeCredentials = Schema.encodeSync(credentialsJson);

/** The sealed form of a login: the endpoint and the password together. */
export const credentials = (value: Credentials): Redacted.Redacted<string> =>
  Redacted.make(encodeCredentials(value));

export const parseCredentials = Effect.fn("Imap.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError(
      (cause) => new InvalidCredentials({ field: "password", cause: Redacted.make(cause) })
    )
  );
});
