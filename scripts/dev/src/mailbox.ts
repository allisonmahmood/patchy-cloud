/**
 * An environment's dev mailbox: Dovecot in Docker on loopback, under a `.test` host a CA of the
 * environment's own signs a certificate for, seeded once with the scenario's mail, and listed in
 * the instance's mailboxes file so its server reaches it (`scripts/dev/src/server.ts`). `up` asks
 * for it again on every run, restarting a stopped container; `down` and `reset` remove it.
 *
 * It's the only place a dev instance writes to a mailbox: Patchy itself only reads.
 */
import { ImapNetwork } from "@patchy/integrations";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ImapFlow } from "imapflow";
import { hostLabel } from "./plan.js";

export const DOVECOT_IMAGE =
  "dovecot/dovecot:2.4.5@sha256:43c14def08a57f25107593cbcf64a0a6fbae84a7b9de7aa038513c9b21e91914";
/** Dovecot's static password database takes any username with this password. Loopback only. */
export const PASSWORD = "dev-mailbox-password";

/** A message the scenario puts in the mailbox, with at most one attachment. */
export const Message = Schema.Struct({
  folder: Schema.NonEmptyString,
  from: Schema.NonEmptyString,
  subject: Schema.String,
  date: Schema.String,
  text: Schema.String,
  seen: Schema.optionalKey(Schema.Boolean),
  attachment: Schema.optionalKey(
    Schema.Struct({
      filename: Schema.NonEmptyString,
      contentType: Schema.NonEmptyString,
      text: Schema.String
    })
  )
});
export type Message = typeof Message.Type;
export const Mail = Schema.Struct({
  folders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  messages: Schema.Array(Message)
});
export type Mail = typeof Mail.Type;
const decodeMail = Schema.decodeUnknownEffect(Schema.fromJsonString(Mail));
const MailboxesJson = Schema.fromJsonString(Schema.Array(ImapNetwork.LoopbackServer));
const decodeMailboxes = Schema.decodeUnknownOption(MailboxesJson);
const encodeMailboxes = Schema.encodeSync(MailboxesJson);

export class MailboxFailed extends Schema.TaggedError<MailboxFailed>()("DevMailboxFailed", {
  step: Schema.String,
  detail: Schema.String
}) {
  override get message() {
    return `The dev mailbox failed while ${this.step}: ${this.detail}`;
  }
}

/** The login the connect page is given for a started mailbox. */
export interface Login {
  readonly host: string;
  readonly username: string;
  readonly password: string;
}

/** One worktree's mailbox container. */
export const containerName = (worktree: string) => `patchy-dev-${hostLabel(worktree)}-mail`;

const exec = Effect.fn("Mailbox.exec")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdin: "ignore", extendEnv: true })
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      );
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    })
  ).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: `${command} didn't run`, exitCode: -1 }))
  );
});
const must = Effect.fn("Mailbox.must")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>
) {
  const result = yield* exec(command, args);
  if (result.exitCode !== 0)
    return yield* new MailboxFailed({ step, detail: result.stderr || result.stdout });
  return result.stdout;
});

/** A CA and a certificate it signs for `host`, kept in `dir` so a restarted container keeps them. */
const certificates = Effect.fn("Mailbox.certificates")(function* (dir: string, host: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = (name: string) => path.join(dir, name);
  if (yield* fs.exists(at("tls.crt"))) return yield* fs.readFileString(at("ca.pem"));
  yield* fs.makeDirectory(dir, { recursive: true });
  const step = "making its certificate";
  yield* must(step, "openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "825",
    "-subj",
    "/CN=Patchy dev mailbox CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    at("ca.key"),
    "-out",
    at("ca.pem")
  ]);
  yield* must(step, "openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${host}`,
    "-keyout",
    at("tls.key"),
    "-out",
    at("tls.csr")
  ]);
  yield* fs.writeFileString(
    at("tls.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${host}`
    ].join("\n")
  );
  yield* must(step, "openssl", [
    "x509",
    "-req",
    "-in",
    at("tls.csr"),
    "-CA",
    at("ca.pem"),
    "-CAkey",
    at("ca.key"),
    "-CAcreateserial",
    "-days",
    "825",
    "-extfile",
    at("tls.ext"),
    "-out",
    at("tls.crt")
  ]);
  // Dovecot reads them as its own user.
  for (const name of ["tls.crt", "tls.key"]) yield* fs.chmod(at(name), 0o644);
  return yield* fs.readFileString(at("ca.pem"));
});

const encodeWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
const base64 = (value: string) =>
  (
    Buffer.from(value)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
/** One message as a mail client would store it: plain text, and its attachment if it has one. */
const compose = (message: Message, to: string, index: number) => {
  const from = /^(.*)<(.+)>$/.exec(message.from);
  const headers = [
    `From: ${from === null ? message.from : `${encodeWord(from[1]!.trim())} <${from[2]}>`}`,
    `To: ${to}`,
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${DateTime.toDateUtc(DateTime.makeUnsafe(message.date)).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <dev-${index}@${to.split("@")[1]}>`,
    "MIME-Version: 1.0"
  ];
  const text = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(message.text)
  ];
  if (message.attachment === undefined) return [...headers, ...text].join("\r\n");
  const boundary = `dev-mailbox-${index}`;
  const { filename, contentType } = message.attachment;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...text,
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64(message.attachment.text),
    `--${boundary}--`,
    ""
  ].join("\r\n");
};

/** Puts the scenario's folders and messages in the new mailbox, over IMAP as a mail client would. */
const seed = (port: number, ca: string, login: Login, mail: Mail) =>
  Effect.tryPromise({
    try: async () => {
      const client = new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: true,
        servername: login.host,
        tls: { ca: [ca], minVersion: "TLSv1.2" },
        auth: { user: login.username, pass: login.password },
        logger: false
      });
      await client.connect();
      try {
        const folders = new Set([
          ...(mail.folders ?? []),
          ...mail.messages.map((message) => message.folder)
        ]);
        for (const folder of folders) if (folder !== "INBOX") await client.mailboxCreate(folder);
        for (const [index, message] of mail.messages.entries())
          await client.append(
            message.folder,
            compose(message, login.username, index),
            message.seen === true ? ["\\Seen"] : [],
            DateTime.toDateUtc(DateTime.makeUnsafe(message.date))
          );
      } finally {
        await client.logout();
      }
    },
    catch: (cause) =>
      new MailboxFailed({
        step: "putting the scenario's mail in it",
        detail: cause instanceof Error ? cause.message : String(cause)
      })
  });

/** Waits until Dovecot answers on `port`, as the container starts. */
const ready = Effect.fn("Mailbox.ready")(function* (name: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = yield* exec("docker", ["exec", name, "doveadm", "service", "status", "imap"]);
    if (result.exitCode === 0) return;
    yield* Effect.sleep("500 millis");
  }
  return yield* new MailboxFailed({ step: "starting", detail: "Dovecot didn't come up in 30s." });
});

/** The loopback port Docker published for the container's IMAPS. */
const publishedPort = Effect.fn("Mailbox.publishedPort")(function* (name: string, port: number) {
  const mapping = yield* must("reading its port", "docker", ["port", name, `${port}/tcp`]);
  const found = /:(\d+)\s*$/m.exec(mapping.split("\n")[0] ?? "");
  if (found === null)
    return yield* new MailboxFailed({ step: "reading its port", detail: mapping || "none" });
  return Number(found[1]);
});

/** Lists the mailbox in the instance's mailboxes file, replacing an older entry for its host. */
const list = Effect.fn("Mailbox.list")(function* (
  file: string,
  server: ImapNetwork.LoopbackServer
) {
  const fs = yield* FileSystem.FileSystem;
  const current = (yield* fs.exists(file))
    ? Option.getOrElse(decodeMailboxes(yield* fs.readFileString(file)), () => [])
    : [];
  yield* fs.writeFileString(
    file,
    encodeMailboxes([...current.filter((item) => item.host !== server.host), server])
  );
});

/**
 * Starts this worktree's dev mailbox for `company`, or restarts it, and lists it for the instance.
 * The first start seeds `mail`. None without Docker, for `up` to skip the connection and say so.
 */
export const startMailbox = Effect.fn("Mailbox.start")(function* (input: {
  readonly worktree: string;
  /** The environment's folder, which keeps the CA across restarts. */
  readonly dir: string;
  /** The instance's mailboxes file, which its server reads. */
  readonly mailboxes: string;
  readonly company: string;
  readonly username: string;
  readonly mail: Option.Option<string>;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if ((yield* exec("docker", ["version", "--format", "{{.Server.Version}}"])).exitCode !== 0)
    return Option.none<Login>();
  const name = containerName(input.worktree);
  const login: Login = {
    host: `mail.${input.company}.test`,
    username: input.username,
    password: PASSWORD
  };
  const certs = path.join(input.dir, "mailbox");
  const ca = yield* certificates(certs, login.host);
  const state = yield* exec("docker", ["inspect", "--format", "{{.State.Running}}", name]);
  if (state.exitCode !== 0) {
    yield* must("starting its container", "docker", [
      "run",
      "-d",
      "--name",
      name,
      "-e",
      `USER_PASSWORD=${PASSWORD}`,
      "-v",
      `${path.join(certs, "tls.crt")}:/etc/dovecot/ssl/tls.crt:ro`,
      "-v",
      `${path.join(certs, "tls.key")}:/etc/dovecot/ssl/tls.key:ro`,
      "-p",
      "127.0.0.1::31993",
      "-p",
      "127.0.0.1::31143",
      DOVECOT_IMAGE
    ]);
    yield* ready(name);
    const tls = yield* publishedPort(name, 31993);
    if (Option.isSome(input.mail)) {
      const mail = yield* decodeMail(yield* fs.readFileString(input.mail.value)).pipe(
        Effect.mapError(
          (cause) =>
            new MailboxFailed({ step: "reading the scenario's mail", detail: cause.message })
        )
      );
      yield* seed(tls, ca, login, mail);
    }
  } else if (state.stdout !== "true") {
    yield* must("restarting its container", "docker", ["start", name]);
    yield* ready(name);
  }
  yield* list(input.mailboxes, {
    host: login.host,
    ports: {
      993: yield* publishedPort(name, 31993),
      143: yield* publishedPort(name, 31143)
    },
    ca
  });
  return Option.some(login);
});

/** Removes this worktree's dev mailbox and its mail, if it has one. */
export const takeDownMailbox = Effect.fn("Mailbox.takeDown")(function* (worktree: string) {
  yield* exec("docker", ["rm", "-f", containerName(worktree)]);
});
