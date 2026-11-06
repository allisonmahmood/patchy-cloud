// @effect-diagnostics nodeBuiltinImport:off -- a scripted IMAP server over real sockets, TLS and OpenSSL certificates.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket, type TlsOptions } from "node:tls";
import { promisify } from "node:util";
import { FileStaging, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ImapNetwork from "../imap/Network.js";
import * as ImapSessions from "../imap/Sessions.js";
import * as ImapSource from "../imap/Source.js";

const repo = new URL("../../../../", import.meta.url);
/** A file of this repo, from its root. */
export const repoFile = (path: string) => readFileSync(new URL(path, repo), "utf8");
/** The fenced block of the `patchy-imap` skill that follows the line `label`, such as "`server/importer.ts`:". */
export const skillBlock = (label: string) => {
  const skill = repoFile("packages/sdk/skills/patchy-imap/SKILL.md");
  const at = skill.indexOf(`\n${label}\n`);
  if (at === -1) throw new Error(`The patchy-imap skill has no block after ${label}.`);
  const open = skill.indexOf("```ts\n", at);
  return skill.slice(open + "```ts\n".length, skill.indexOf("\n```", open + 1));
};

/** What a test's host staging was handed: the bytes, as an action would adopt them. */
export interface Staged {
  readonly token: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}
/**
 * Host staging that keeps what it staged in memory, for suites about what reaches staging. Files'
 * own contract holds the real staging's quotas, expiry and adoption; `refuse` stands in a quota.
 */
export const recordingStaging = (refuse?: () => Runtime.RuntimeError | undefined) => {
  const staged: Staged[] = [];
  const refused = Effect.suspend(() => {
    const refusal = refuse?.();
    return refusal === undefined ? Effect.void : Effect.fail(refusal);
  });
  const service = FileStaging.FileStaging.of({
    admits: () => refused,
    stage: (bytes, contentType) =>
      Effect.suspend(() => {
        const refusal = refuse?.();
        if (refusal !== undefined) return Effect.fail(refusal);
        const token = randomBytes(16).toString("hex");
        staged.push({ token, bytes, contentType });
        return Effect.succeed({
          upload: { token, size: bytes.byteLength, contentType },
          sha256: createHash("sha256").update(bytes).digest("hex")
        });
      })
  });
  return { staged, service };
};

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

/**
 * A message's attachment, part 2. With `content`, FETCH serves it: `BODY[2]` transfer-encoded as
 * `encoding` says (base64 by default), `BINARY[2]` decoded, `BODY[2.MIME]` its headers, each
 * partial `<start.length>` as asked. Without, BODYSTRUCTURE states `bytes` and nothing serves it.
 */
export interface ScriptedAttachment {
  readonly filename: string;
  readonly bytes: number;
  readonly content?: Uint8Array;
  readonly encoding?: "base64" | "quoted-printable" | "8bit";
  readonly contentType?: string;
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
  readonly attachment?: ScriptedAttachment;
  /** A forwarded message as part 3, in BODYSTRUCTURE only: nothing serves its sections. */
  readonly forwarded?: boolean;
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
/** An attachment's bytes as BODY serves them: transfer-encoded, base64 in 76-character lines. */
const encoded = (attachment: ScriptedAttachment): Buffer => {
  const content = Buffer.from(attachment.content ?? new Uint8Array());
  switch (attachment.encoding ?? "base64") {
    case "8bit":
      return content;
    case "quoted-printable": {
      let out = "";
      let line = 0;
      for (const byte of content) {
        const piece =
          (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32
            ? String.fromCharCode(byte)
            : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        if (line + piece.length > 75) {
          out += "=\r\n";
          line = 0;
        }
        out += piece;
        line += piece.length;
      }
      return Buffer.from(out, "latin1");
    }
    case "base64":
      return Buffer.from(
        (content.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
        "latin1"
      );
  }
};
const [mediaType, mediaSubtype] = ["APPLICATION", "PDF"];
const attachmentPart = (attachment: ScriptedAttachment) => {
  const [type, subtype] = attachment.contentType?.toUpperCase().split("/") ?? [
    mediaType,
    mediaSubtype
  ];
  const size = attachment.content === undefined ? attachment.bytes : encoded(attachment).length;
  return `(${quoted(type)} ${quoted(subtype)} ("NAME" ${quoted(attachment.filename)}) NIL NIL ${quoted((attachment.encoding ?? "base64").toUpperCase())} ${size} NIL ("ATTACHMENT" ("FILENAME" ${quoted(attachment.filename)})) NIL NIL)`;
};
const forwardedPart = (message: ScriptedMessage) =>
  `("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 120 ${envelope(message)} ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1) 5 NIL ("ATTACHMENT" NIL) NIL NIL)`;
const bodyStructure = (message: ScriptedMessage) =>
  message.attachment === undefined && message.forwarded !== true
    ? textPart(message)
    : `(${textPart(message)}${message.attachment === undefined ? "" : attachmentPart(message.attachment)}${message.forwarded === true ? forwardedPart(message) : ""} "MIXED")`;
const mimeHeaders = (attachment: ScriptedAttachment) =>
  `Content-Type: ${attachment.contentType ?? "application/pdf"}; name="${attachment.filename}"\r\nContent-Transfer-Encoding: ${attachment.encoding ?? "base64"}\r\nContent-Disposition: attachment; filename="${attachment.filename}"\r\n\r\n`;
const referencesHeader = (message: ScriptedMessage) =>
  message.references === undefined || message.references.length === 0
    ? "\r\n"
    : `References: ${message.references.join(" ")}\r\n\r\n`;
const literal = (value: string) => `{${Buffer.byteLength(value)}}\r\n${value}`;
/** A literal of raw bytes; `eight` makes it literal8, as BINARY answers. */
const literalBytes = (bytes: Buffer, eight = false) => [
  Buffer.from(`${eight ? "~" : ""}{${bytes.length}}\r\n`, "latin1"),
  bytes
];

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
  /** Sessions logged in now: their login was answered OK and their socket isn't closed yet. */
  readonly signedIn: () => number;
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
    const signedIn = new Set<Socket>();
    const session = (socket: Socket, secure: boolean, greet: boolean) => {
      socket.on("error", () => {});
      socket.once("close", () => signedIn.delete(socket));
      const loggedIn = (reply: string | Promise<string>) =>
        Promise.resolve(reply).then((text) => {
          if (text.startsWith("OK") && !socket.destroyed) signedIn.add(socket);
          return text;
        });
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
        const sections = [
          ...line.matchAll(/(BODY|BINARY)\.PEEK\[(\d+(?:\.\d+)*)(\.MIME)?\](?:<(\d+)\.(\d+)>)?/gi)
        ];
        for (const message of chosen) {
          // Each item is its pieces, joined by nothing; items are joined by a space.
          const items: Buffer[][] = [];
          const item = (...pieces: Array<string | Buffer>) =>
            items.push(
              pieces.map((piece) => (typeof piece === "string" ? Buffer.from(piece) : piece))
            );
          item(`UID ${message.uid}`);
          if (line.includes("FLAGS")) item(`FLAGS (${message.seen === true ? "\\Seen" : ""})`);
          if (line.includes("INTERNALDATE"))
            item(`INTERNALDATE "${imapDay(message.day)} 10:00:00 +0000"`);
          if (line.includes("RFC822.SIZE"))
            item(
              `RFC822.SIZE ${Buffer.byteLength(textOf(message)) + 400 + (message.attachment?.content === undefined ? 0 : encoded(message.attachment).length)}`
            );
          if (line.includes("ENVELOPE")) item(`ENVELOPE ${envelope(message)}`);
          if (line.includes("BODYSTRUCTURE")) item(`BODYSTRUCTURE ${bodyStructure(message)}`);
          if (line.includes("HEADER.FIELDS"))
            item(`BODY[HEADER.FIELDS (REFERENCES)] ${literal(referencesHeader(message))}`);
          const attachment =
            message.attachment?.content === undefined ? undefined : message.attachment;
          for (const [, kind, part, mime, start, length] of sections) {
            const from = Number(start ?? 0);
            const slice = (bytes: Buffer) =>
              length === undefined ? bytes : bytes.subarray(from, from + Number(length));
            const origin = start === undefined ? "" : `<${from}>`;
            const binary = kind!.toUpperCase() === "BINARY";
            if (part === "1" && mime === undefined)
              item(`BODY[1]${origin} `, ...literalBytes(slice(Buffer.from(textOf(message)))));
            else if (part === "2" && attachment !== undefined && mime !== undefined)
              item("BODY[2.MIME] ", ...literalBytes(Buffer.from(mimeHeaders(attachment))));
            else if (part === "2" && attachment !== undefined)
              item(
                `${binary ? "BINARY" : "BODY"}[2]${origin} `,
                ...literalBytes(
                  slice(binary ? Buffer.from(attachment.content!) : encoded(attachment)),
                  binary
                )
              );
          }
          socket.write(
            Buffer.concat([
              Buffer.from(`* ${messages.indexOf(message) + 1} FETCH (`),
              ...items.flatMap((pieces, index) =>
                index === 0 ? pieces : [Buffer.from(" "), ...pieces]
              ),
              Buffer.from(")\r\n")
            ])
          );
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
              answer(tag, loggedIn(login("LOGIN")));
              break;
            case "AUTHENTICATE":
              say("+ ");
              continuation = () => answer(tag, loggedIn(login("AUTHENTICATE")));
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
      dials,
      signedIn: () => signedIn.size
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
