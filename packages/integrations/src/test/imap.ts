// @effect-diagnostics nodeBuiltinImport:off -- a scripted IMAP server over real sockets, TLS and OpenSSL certificates.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket, type TlsOptions } from "node:tls";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ImapNetwork from "../imap/Network.js";
import * as ImapSessions from "../imap/Sessions.js";
import * as ImapSource from "../imap/Source.js";

/** The IMAP source and its session pool over production's network, for suites that reach no mailbox. */
export const offline = ImapSessions.layer.pipe(
  Layer.provideMerge(ImapSource.layer),
  Layer.provide(ImapNetwork.layer)
);

const openssl = promisify(execFile);

/** A disposable CA and a server certificate it signed for `names`. */
export interface Certificates {
  readonly ca: string;
  readonly key: string;
  readonly cert: string;
}

/**
 * Makes a CA and a certificate for `names` with OpenSSL, in a folder removed with the scope.
 * `signer` signs with another CA's key instead, for a certificate no one trusts.
 */
export const certificates = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "patchy-imap-tls-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    );
    return yield* Effect.promise(async () => {
      const at = (name: string) => join(directory, name);
      await openssl("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=Patchy disposable IMAP CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        at("ca.key"),
        "-out",
        at("ca.pem")
      ]);
      await openssl("openssl", [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        `/CN=${names[0]}`,
        "-keyout",
        at("server.key"),
        "-out",
        at("server.csr")
      ]);
      await writeFile(
        at("server.ext"),
        [
          "basicConstraints=critical,CA:FALSE",
          "keyUsage=critical,digitalSignature,keyEncipherment",
          "extendedKeyUsage=serverAuth",
          `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`
        ].join("\n")
      );
      await openssl("openssl", [
        "x509",
        "-req",
        "-in",
        at("server.csr"),
        "-CA",
        at("ca.pem"),
        "-CAkey",
        at("ca.key"),
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        at("server.ext"),
        "-out",
        at("server.pem")
      ]);
      const [ca, key, cert] = await Promise.all(
        ["ca.pem", "server.key", "server.pem"].map((name) => readFile(at(name), "utf8"))
      );
      return { ca: ca!, key: key!, cert: cert! } satisfies Certificates;
    });
  });

/** What the scripted server says; every field has a default an honest server would answer. */
export interface Script {
  /** Advertised before login: in the greeting, to CAPABILITY, and again after STARTTLS. */
  readonly capabilities?: ReadonlyArray<string>;
  /** Whether port 143 offers STARTTLS; it's advertised only before TLS. */
  readonly starttls?: boolean;
  /** The tagged reply to LOGIN or AUTHENTICATE PLAIN, after the tag: `OK …`, `NO […] …`, `BAD …`. */
  readonly login?: (method: "LOGIN" | "AUTHENTICATE") => string | Promise<string>;
  /** Greets PREAUTH, as logged in already, instead of OK. */
  readonly preauth?: boolean;
  /** LIST's folders, each `path` with its flags. */
  readonly folders?: ReadonlyArray<{ readonly path: string; readonly flags?: string }>;
  /** Whether EXAMINE INBOX succeeds. */
  readonly inbox?: boolean;
  /** TLS settings beyond the certificate, such as a highest version. */
  readonly tls?: TlsOptions;
  /**
   * Folders holding mail, for reads: EXAMINE, STATUS, UID SEARCH (with ESEARCH's `RETURN (MIN)`
   * when `capabilities` has ESEARCH), FETCH and UID FETCH answer from them. Tests may change them
   * between commands, as mail arriving or expunged elsewhere would. LIST names them when
   * `folders` doesn't.
   */
  readonly mailboxes?: ReadonlyArray<ScriptedFolder>;
  /**
   * Runs before each command after login is answered: it may change the mailboxes, wait, or
   * answer `"drop"` to close the connection with the command unanswered.
   */
  readonly before?: (line: string) => void | "drop" | Promise<void | "drop">;
}

/** One message in a scripted folder: a text/plain body, and at most one attachment. */
export interface ScriptedMessage {
  readonly uid: number;
  /** Its internal date, `YYYY-MM-DD`, at 10:00 UTC. */
  readonly day: string;
  readonly subject?: string;
  readonly from?: string;
  readonly to?: ReadonlyArray<string>;
  readonly seen?: boolean;
  readonly text?: string;
  readonly attachment?: { readonly filename: string; readonly bytes: number };
  readonly references?: ReadonlyArray<string>;
}
export interface ScriptedFolder {
  readonly path: string;
  readonly uidValidity: number;
  /** UIDNEXT; one past the highest UID when left out. */
  readonly uidNext?: number;
  readonly messages: Array<ScriptedMessage>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const quoted = (value: string | undefined) =>
  value === undefined ? "NIL" : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const imapDay = (day: string) => {
  const [year, month, date] = day.split("-");
  return `${date}-${MONTHS[Number(month) - 1]}-${year}`;
};
const address = (value: string | undefined) => {
  if (value === undefined) return "NIL";
  const [mailbox, host] = value.split("@");
  return `((NIL NIL ${quoted(mailbox)} ${quoted(host)}))`;
};
const addresses = (values: ReadonlyArray<string> | undefined) =>
  values === undefined || values.length === 0
    ? "NIL"
    : `(${values.map((value) => address(value).slice(1, -1)).join("")})`;
const textOf = (message: ScriptedMessage) => message.text ?? "";
const envelope = (message: ScriptedMessage) =>
  `(${quoted(`${message.day.split("-")[2]} ${MONTHS[Number(message.day.split("-")[1]) - 1]} ${message.day.split("-")[0]} 09:00:00 +0000`)} ${quoted(message.subject)} ${address(message.from)} ${address(message.from)} ${address(message.from)} ${addresses(message.to)} NIL NIL NIL ${quoted(`<${message.uid}@scripted.test>`)})`;
const textPart = (message: ScriptedMessage) =>
  `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${Buffer.byteLength(textOf(message))} ${textOf(message).split("\n").length})`;
const bodyStructure = (message: ScriptedMessage) =>
  message.attachment === undefined
    ? textPart(message)
    : `(${textPart(message)}("APPLICATION" "PDF" ("NAME" ${quoted(message.attachment.filename)}) NIL NIL "BASE64" ${message.attachment.bytes} NIL ("ATTACHMENT" ("FILENAME" ${quoted(message.attachment.filename)})) NIL NIL) "MIXED")`;
const referencesHeader = (message: ScriptedMessage) =>
  message.references === undefined || message.references.length === 0
    ? "\r\n"
    : `References: ${message.references.join(" ")}\r\n\r\n`;
const literal = (value: string) => `{${Buffer.byteLength(value)}}\r\n${value}`;

/** The UIDs `set` names among `uids`: `3:5,9`, `7`, never past the highest for `n:*`. */
const inSet = (set: string, uids: ReadonlyArray<number>) => {
  const highest = Math.max(0, ...uids);
  const ranges = set.split(",").map((range) => {
    const [low, high = low] = range.split(":").map((end) => (end === "*" ? highest : Number(end)));
    return [Math.min(low!, high!), Math.max(low!, high!)] as const;
  });
  return uids.filter((uid) => ranges.some(([low, high]) => uid >= low && uid <= high));
};
/** A command's arguments: atoms, quoted strings and parentheses. */
const tokens = (line: string) =>
  [...line.matchAll(/"((?:[^"\\]|\\.)*)"|\(|\)|[^\s()]+/g)].map((match) =>
    match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[0]
  );
const dayOf = (token: string) => {
  const [date, month, year] = token.split("-");
  return `${year}-${String(MONTHS.indexOf(month!) + 1).padStart(2, "0")}-${date!.padStart(2, "0")}`;
};
/** The messages a UID SEARCH's criteria match: UID sets, dates, seen and substring keys. */
const matching = (criteria: ReadonlyArray<string>, messages: ReadonlyArray<ScriptedMessage>) => {
  let found = [...messages];
  for (let index = 0; index < criteria.length; index++) {
    const key = criteria[index]!.toUpperCase();
    const value = criteria[index + 1] ?? "";
    const has = (field: string | undefined) =>
      (field ?? "").toLowerCase().includes(value.toLowerCase());
    if (key === "UID") {
      const uids = inSet(
        value,
        found.map((message) => message.uid)
      );
      found = found.filter((message) => uids.includes(message.uid));
      index++;
    } else if (key === "SINCE") {
      found = found.filter((message) => message.day >= dayOf(value));
      index++;
    } else if (key === "BEFORE") {
      found = found.filter((message) => message.day < dayOf(value));
      index++;
    } else if (key === "SEEN") found = found.filter((message) => message.seen === true);
    else if (key === "UNSEEN") found = found.filter((message) => message.seen !== true);
    else if (key === "SUBJECT") {
      found = found.filter((message) => has(message.subject));
      index++;
    } else if (key === "FROM") {
      found = found.filter((message) => has(message.from));
      index++;
    } else if (key === "TO") {
      found = found.filter((message) => has(message.to?.join(" ")));
      index++;
    } else if (key === "TEXT") {
      found = found.filter((message) => has(`${message.subject ?? ""} ${textOf(message)}`));
      index++;
    }
  }
  return found;
};

/** A running scripted server and what it saw. */
export interface Served {
  /** Implicit TLS, what 993 dials. */
  readonly tls: number;
  /** Cleartext with STARTTLS, what 143 dials. */
  readonly plain: number;
  /** Every command by its name and first argument; a password is never kept. */
  readonly commands: Array<string>;
  /** Every command line as sent, without its tag; a login's is `LOGIN` alone. */
  readonly lines: Array<string>;
  /**
   * The checked address of every session Patchy dialled through `network`. Counted at the seam,
   * not the socket: anything else on this machine may connect to a loopback port too.
   */
  readonly dials: Array<string>;
}

const defaults = ["IMAP4rev1", "AUTH=PLAIN", "ID", "NAMESPACE", "SPECIAL-USE"];

/**
 * A minimal IMAP server for one script, on loopback, closed with the scope: enough of RFC 3501
 * for ImapFlow's connect, LIST, EXAMINE and LOGOUT. Anything else is answered BAD and recorded.
 */
export const serve = (certs: Certificates, script: Script = {}) =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const lines: string[] = [];
    const dials: string[] = [];
    const capabilities = (secure: boolean) =>
      [
        ...(script.capabilities ?? defaults),
        ...(!secure && script.starttls !== false ? ["STARTTLS"] : []),
        ...(!secure ? ["LOGINDISABLED"] : [])
      ].join(" ");
    const login = script.login ?? (() => "OK Logged in");
    const session = (socket: Socket, secure: boolean, greet: boolean) => {
      socket.on("error", () => {});
      const say = (line: string) => socket.write(`${line}\r\n`);
      if (greet)
        say(
          `* ${script.preauth === true ? "PREAUTH" : "OK"} [CAPABILITY ${capabilities(secure)}] Scripted IMAP ready`
        );
      // A reply may wait, as a slow server's would; the client sends nothing until it arrives.
      const answer = (tag: string, reply: string | Promise<string>) =>
        void Promise.resolve(reply).then((text) => say(`${tag} ${text}`));
      let buffer = "";
      let continuation: ((line: string) => void) | undefined;
      let selected: ScriptedFolder | undefined;
      // Commands are answered one at a time, in order, as `before` may wait.
      let queue: Promise<void> = Promise.resolve();
      const folderNamed = (token: string | undefined) =>
        script.mailboxes?.find((folder) => folder.path === token);
      /** Answers the reads a scripted mailbox holds; false for any other command. */
      const read = (tag: string, line: string): boolean => {
        const parts = tokens(line);
        const command = (parts[1] ?? "").toUpperCase();
        if (command === "EXAMINE" && script.mailboxes !== undefined) {
          const folder = folderNamed(parts[2]);
          if (folder === undefined) {
            say(`${tag} NO [NONEXISTENT] Mailbox doesn't exist`);
            return true;
          }
          selected = folder;
          const uids = folder.messages.map((message) => message.uid);
          say(`* ${folder.messages.length} EXISTS`);
          say(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`);
          say(`* OK [UIDNEXT ${folder.uidNext ?? Math.max(0, ...uids) + 1}] Predicted next UID`);
          say(`${tag} OK [READ-ONLY] Examine completed`);
          return true;
        }
        if (command === "STATUS" && script.mailboxes !== undefined) {
          const folder = folderNamed(parts[2]);
          if (folder === undefined) {
            say(`${tag} NO [NONEXISTENT] Mailbox doesn't exist`);
            return true;
          }
          const uids = folder.messages.map((message) => message.uid);
          const unseen = folder.messages.filter((message) => message.seen !== true).length;
          say(
            `* STATUS ${quoted(folder.path)} (MESSAGES ${folder.messages.length} UNSEEN ${unseen} UIDVALIDITY ${folder.uidValidity} UIDNEXT ${folder.uidNext ?? Math.max(0, ...uids) + 1})`
          );
          say(`${tag} OK Status completed`);
          return true;
        }
        const uid = command === "UID";
        const verb = (uid ? (parts[2] ?? "") : command).toUpperCase();
        if (selected === undefined || (verb !== "SEARCH" && verb !== "FETCH")) return false;
        const messages = selected.messages;
        if (verb === "SEARCH") {
          const rest = parts.slice(uid ? 3 : 2);
          const min = rest[0]?.toUpperCase() === "RETURN";
          const found = matching(min ? rest.slice(4) : rest, messages).map((message) =>
            uid ? message.uid : messages.indexOf(message) + 1
          );
          if (min)
            say(
              `* ESEARCH (TAG "${tag}")${uid ? " UID" : ""}${found.length === 0 ? "" : ` MIN ${Math.min(...found)}`}`
            );
          else say(`* SEARCH${found.map((number) => ` ${number}`).join("")}`);
          say(`${tag} OK Search completed`);
          return true;
        }
        const set = parts[uid ? 3 : 2] ?? "";
        const chosen = uid
          ? inSet(
              set,
              messages.map((message) => message.uid)
            ).map((number) => messages.find((message) => message.uid === number)!)
          : inSet(
              set,
              messages.map((_, index) => index + 1)
            ).map((number) => messages[number - 1]!);
        const partials = [...line.matchAll(/BODY\.PEEK\[(\d+(?:\.\d+)*)\]<0\.(\d+)>/g)];
        for (const message of chosen) {
          const items = [`UID ${message.uid}`];
          if (line.includes("FLAGS"))
            items.push(`FLAGS (${message.seen === true ? "\\Seen" : ""})`);
          if (line.includes("INTERNALDATE"))
            items.push(`INTERNALDATE "${imapDay(message.day)} 10:00:00 +0000"`);
          if (line.includes("RFC822.SIZE"))
            items.push(`RFC822.SIZE ${Buffer.byteLength(textOf(message)) + 400}`);
          if (line.includes("ENVELOPE")) items.push(`ENVELOPE ${envelope(message)}`);
          if (line.includes("BODYSTRUCTURE")) items.push(`BODYSTRUCTURE ${bodyStructure(message)}`);
          if (line.includes("HEADER.FIELDS"))
            items.push(`BODY[HEADER.FIELDS (REFERENCES)] ${literal(referencesHeader(message))}`);
          for (const [, part, length] of partials)
            if (part === "1")
              items.push(`BODY[1]<0> ${literal(textOf(message).slice(0, Number(length)))}`);
          say(`* ${messages.indexOf(message) + 1} FETCH (${items.join(" ")})`);
        }
        say(`${tag} OK Fetch completed`);
        return true;
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (continuation !== undefined) {
            const answer = continuation;
            continuation = undefined;
            answer(line);
            continue;
          }
          const [tag = "*", name = "", argument = ""] = line.split(" ");
          const command = name.toUpperCase();
          commands.push(command === "LOGIN" ? "LOGIN" : `${command} ${argument}`.trim());
          lines.push(command === "LOGIN" ? "LOGIN" : line.slice(tag.length + 1));
          if (
            script.mailboxes !== undefined &&
            ["EXAMINE", "STATUS", "UID", "FETCH", "SEARCH", "SELECT", "LIST", "NOOP"].includes(
              command
            )
          ) {
            queue = queue.then(async () => {
              if ((await script.before?.(line)) === "drop") {
                socket.destroy();
                return;
              }
              if (command === "LIST" && script.folders === undefined) {
                if (line.endsWith(' "" ""')) say('* LIST (\\Noselect) "/" ""');
                else
                  for (const folder of script.mailboxes ?? [])
                    say(`* LIST (\\HasNoChildren) "/" ${quoted(folder.path)}`);
                say(`${tag} OK List completed`);
                return;
              }
              if (!read(tag, line))
                say(
                  command === "NOOP"
                    ? `${tag} OK Noop completed`
                    : command === "LIST"
                      ? `${tag} OK List completed`
                      : `${tag} BAD Not scripted`
                );
            });
            continue;
          }
          switch (command) {
            case "CAPABILITY":
              say(`* CAPABILITY ${capabilities(secure)}`);
              say(`${tag} OK Capability completed`);
              break;
            case "ID":
              say("* ID NIL");
              say(`${tag} OK ID completed`);
              break;
            case "STARTTLS":
              if (secure || script.starttls === false) {
                say(`${tag} BAD STARTTLS unavailable`);
                break;
              }
              socket.off("data", onData);
              say(`${tag} OK Begin TLS negotiation now`);
              session(
                new TLSSocket(socket, { isServer: true, key: certs.key, cert: certs.cert }),
                true,
                false
              );
              return;
            case "LOGIN":
              answer(tag, login("LOGIN"));
              break;
            case "AUTHENTICATE":
              say("+ ");
              continuation = () => answer(tag, login("AUTHENTICATE"));
              break;
            case "NAMESPACE":
              say('* NAMESPACE (("" "/")) NIL NIL');
              say(`${tag} OK Namespace completed`);
              break;
            case "ENABLE":
              say(`${tag} OK Enabled`);
              break;
            case "LIST":
              // `LIST "" ""` asks only for the hierarchy delimiter (RFC 3501 6.3.8).
              if (line.endsWith(' "" ""')) say('* LIST (\\Noselect) "/" ""');
              else
                for (const folder of script.folders ?? [{ path: "INBOX" }])
                  say(`* LIST (${folder.flags ?? "\\HasNoChildren"}) "/" "${folder.path}"`);
              say(`${tag} OK List completed`);
              break;
            case "EXAMINE":
              if (script.inbox === false) {
                say(`${tag} NO [NONEXISTENT] Mailbox doesn't exist`);
                break;
              }
              say("* 0 EXISTS");
              say("* OK [UIDVALIDITY 7] UIDs valid");
              say("* OK [UIDNEXT 1] Predicted next UID");
              say(`${tag} OK [READ-ONLY] Examine completed`);
              break;
            case "NOOP":
              say(`${tag} OK Noop completed`);
              break;
            case "LOGOUT":
              say("* BYE Logging out");
              say(`${tag} OK Logout completed`);
              socket.end();
              return;
            default:
              say(`${tag} BAD Not scripted`);
          }
        }
      };
      socket.on("data", onData);
    };
    const listen = (server: Server) =>
      Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                resolve(typeof address === "object" && address !== null ? address.port : 0);
              });
            })
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                // Sessions a test left open would keep close waiting.
                for (const socket of open) socket.destroy();
              })
          )
      );
    const open = new Set<Socket>();
    const track = (socket: Socket) => {
      open.add(socket);
      socket.once("close", () => open.delete(socket));
    };
    const implicit = createTlsServer(
      { ...script.tls, key: certs.key, cert: certs.cert },
      (socket) => session(socket, true, true)
    );
    implicit.on("connection", track);
    implicit.on("tlsClientError", () => {});
    const plain = createTcpServer((socket) => session(socket, false, true));
    plain.on("connection", track);
    return {
      tls: yield* listen(implicit),
      plain: yield* listen(plain),
      commands,
      lines,
      dials
    } satisfies Served;
  });

/**
 * A network that resolves `hosts` to loopback and dials the scripted server for them, recording
 * each dial in `served.dials`.
 */
export const network = (
  served: Served,
  certs: Certificates,
  hosts: ReadonlyArray<string> = ["mail.example.test"]
) =>
  Layer.effect(
    ImapNetwork.Network,
    Effect.gen(function* () {
      const loopback = yield* ImapNetwork.Network;
      return ImapNetwork.Network.of({
        ...loopback,
        destination: (target) => {
          served.dials.push(target.address);
          return loopback.destination(target);
        }
      });
    })
  ).pipe(
    Layer.provide(
      ImapNetwork.loopback(() =>
        hosts.map((host) => ({ host, ports: { 993: served.tls, 143: served.plain }, ca: certs.ca }))
      )
    )
  );
