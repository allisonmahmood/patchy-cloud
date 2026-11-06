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
}

/** A running scripted server and what it saw. */
export interface Served {
  /** Implicit TLS, what 993 dials. */
  readonly tls: number;
  /** Cleartext with STARTTLS, what 143 dials. */
  readonly plain: number;
  /** Every command by its name and first argument; a password is never kept. */
  readonly commands: Array<string>;
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
