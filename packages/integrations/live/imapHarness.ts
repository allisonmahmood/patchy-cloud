// @effect-diagnostics nodeBuiltinImport:off -- Docker, OpenSSL and the containers' files are the harness's boundary.
/**
 * The IMAP live tier's mail servers: Dovecot, which offers TLS on 993 and STARTTLS on 143 with
 * SPECIAL-USE and BINARY, and GreenMail, a baseline server with neither, whose 143 has no
 * STARTTLS. Each runs in Docker on loopback ports chosen at random, presenting a certificate a
 * disposable CA signed for the hosts the tests type. A global setup: started once per run,
 * removed after it, and named by `PATCHY_IMAP_LIVE_PREFIX` so a shared machine can tell them
 * apart. It needs no secrets.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ImapFlow } from "imapflow";

const run = promisify(execFile);

export const DOVECOT_IMAGE =
  "dovecot/dovecot:2.4.5@sha256:43c14def08a57f25107593cbcf64a0a6fbae84a7b9de7aa038513c9b21e91914";
export const GREENMAIL_IMAGE =
  "greenmail/standalone:2.1.15@sha256:309ba544ea482e5d4265d09921cdab07c8dad2cc4481d715c9b8ff5d3f0a149f";
/** The hosts the certificate names: Dovecot's, GreenMail's. A third name is left off on purpose. */
export const DOVECOT_HOST = "mail.imap-live.test";
export const GREENMAIL_HOST = "baseline.imap-live.test";
export const UNNAMED_HOST = "unnamed.imap-live.test";

/** One server's loopback ports, and the login the tests use. */
export interface LiveServer {
  readonly host: string;
  readonly tls: number;
  readonly plain: number;
  readonly username: string;
  readonly password: string;
}
export interface LiveMail {
  readonly ca: string;
  readonly dovecot: LiveServer;
  readonly greenmail: LiveServer;
}

declare module "vitest" {
  export interface ProvidedContext {
    imap: LiveMail;
  }
}

const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();
/** The loopback port Docker published for a container's port. */
const published = async (name: string, port: number) => {
  const mapping = await docker("port", name, `${port}/tcp`);
  const found = /:(\d+)\s*$/m.exec(mapping.split("\n")[0] ?? "");
  if (found === null) throw new Error(`Docker published no port for ${name}:${port}.`);
  return Number(found[1]);
};
/** Waits until the server greets on `port`, or gives up after a minute. */
const greets = async (port: number) => {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(2_000);
      socket.once("data", (chunk) => {
        socket.destroy();
        resolve(chunk.toString("latin1").startsWith("* OK"));
      });
      socket.once("error", () => resolve(false));
      // Docker's proxy accepts and closes at once while the server is still starting.
      socket.once("close", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Nothing greeted on 127.0.0.1:${port} within a minute.`);
};

const certificates = async (directory: string) => {
  const at = (name: string) => join(directory, name);
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Patchy IMAP live CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    at("ca.key"),
    "-out",
    at("ca.pem")
  ]);
  await run("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${DOVECOT_HOST}`,
    "-keyout",
    at("tls.key"),
    "-out",
    at("tls.csr")
  ]);
  await writeFile(
    at("tls.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${DOVECOT_HOST},DNS:${GREENMAIL_HOST}`
    ].join("\n")
  );
  await run("openssl", [
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
    "1",
    "-extfile",
    at("tls.ext"),
    "-out",
    at("tls.crt")
  ]);
  await run("openssl", [
    "pkcs12",
    "-export",
    "-in",
    at("tls.crt"),
    "-inkey",
    at("tls.key"),
    "-name",
    "greenmail",
    "-passout",
    "pass:greenmail",
    "-out",
    at("greenmail.p12")
  ]);
  // The containers read them as their own users.
  for (const file of ["tls.crt", "tls.key", "greenmail.p12"]) await chmod(at(file), 0o644);
  return readFile(at("ca.pem"), "utf8");
};

/** Folders an admin's mailbox might hold, made over IMAP as a mail client would. */
const seed = async (server: LiveServer, ca: string) => {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: server.tls,
    secure: true,
    servername: server.host,
    tls: { ca: [ca], minVersion: "TLSv1.2" },
    auth: { user: server.username, pass: server.password },
    logger: false
  });
  await client.connect();
  for (const folder of ["Invoices", "Projekte/Überweisungen"]) await client.mailboxCreate(folder);
  await client.logout();
};

export default async function setup({
  provide
}: {
  provide: (key: "imap", value: LiveMail) => void;
}) {
  await docker("version", "--format", "{{.Server.Version}}").catch((cause: unknown) => {
    throw new Error(
      "The IMAP live tier runs Dovecot and GreenMail in Docker, and Docker isn't answering here.",
      { cause }
    );
  });
  const prefix = process.env.PATCHY_IMAP_LIVE_PREFIX ?? `patchy-imap-live-${process.pid}`;
  const names = { dovecot: `${prefix}-dovecot`, greenmail: `${prefix}-greenmail` };
  const directory = await mkdtemp(join(tmpdir(), "patchy-imap-live-"));
  const teardown = async () => {
    await docker("rm", "-f", names.dovecot, names.greenmail).catch(() => "");
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const ca = await certificates(directory);
    const password = "imap-live-password";
    await docker(
      "run",
      "-d",
      "--name",
      names.dovecot,
      "-e",
      `USER_PASSWORD=${password}`,
      "-v",
      `${join(directory, "tls.crt")}:/etc/dovecot/ssl/tls.crt:ro`,
      "-v",
      `${join(directory, "tls.key")}:/etc/dovecot/ssl/tls.key:ro`,
      "-p",
      "127.0.0.1::31993",
      "-p",
      "127.0.0.1::31143",
      DOVECOT_IMAGE
    );
    await docker(
      "run",
      "-d",
      "--name",
      names.greenmail,
      "-e",
      [
        "GREENMAIL_OPTS=-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.imaps",
        "-Dgreenmail.hostname=0.0.0.0",
        `-Dgreenmail.users=invoices:${password}@imap-live.test`,
        "-Dgreenmail.users.login=email",
        "-Dgreenmail.tls.keystore.file=/certs/greenmail.p12",
        "-Dgreenmail.tls.keystore.password=greenmail"
      ].join(" "),
      "-v",
      `${join(directory, "greenmail.p12")}:/certs/greenmail.p12:ro`,
      "-p",
      "127.0.0.1::3993",
      "-p",
      "127.0.0.1::3143",
      GREENMAIL_IMAGE
    );
    const dovecot: LiveServer = {
      host: DOVECOT_HOST,
      tls: await published(names.dovecot, 31993),
      plain: await published(names.dovecot, 31143),
      username: "invoices@imap-live.test",
      password
    };
    const greenmail: LiveServer = {
      host: GREENMAIL_HOST,
      tls: await published(names.greenmail, 3993),
      plain: await published(names.greenmail, 3143),
      username: "invoices@imap-live.test",
      password
    };
    await Promise.all([greets(dovecot.plain), greets(greenmail.plain)]);
    await seed(dovecot, ca);
    provide("imap", { ca, dovecot, greenmail });
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
