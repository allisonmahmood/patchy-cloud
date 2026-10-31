// The built server image, run as production runs it: on Bun, hosts as uid 1000 and the
// exec supervisor as root. CI's `image` job runs this after building the image; it needs
// Docker, openssl and `pnpm install`. The tier 1 and tier 2 journeys run on the same Bun in
// the browser, cli-smoke and tier2-smoke jobs; this checks what only the image shows:
//
// 1. Two hosts on two revisions boot from the image's default command and migrate a
//    database that accepts only TLS, verified against a scratch CA, and SCRAM.
// 2. `dist/fleet.js promote` promotes the second revision, then rolls back to the first.
// 3. A host stops on SIGTERM, as ECS stops it, instead of waiting to be killed.
// 4. The exec supervisor runs as root and starts workerd under a uid of its own.
// 5. `node dist/exec.js`, how older releases' hosts start exec tasks, runs Bun.
//
// Usage: node scripts/server-image-smoke.mjs [--image patchy-server:ci]
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { tsImport } from "tsx/esm/api";
import rootPackage from "../package.json" with { type: "json" };

const { values } = parseArgs({
  options: { image: { type: "string", default: "patchy-server:ci" } }
});
const image = values.image;
const { clerkEnv } = await tsImport("../packages/auth/src/testing.ts", import.meta.url);
const bunVersion = rootPackage.devDependencies.bun.replace(/^runtime:/, "");

const temporary = await mkdtemp(path.join(os.tmpdir(), "patchy-image-smoke-"));
const containers = new Set();
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const say = (message) => console.log(`[image-smoke] ${message}`);
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const until = async (what, check, timeoutMs = 120_000) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100))
    if (await check()) return;
  throw new Error(`${what} within ${timeoutMs / 1000} s`);
};

/**
 * A container on the host's network and process namespace, so local-fleet hosts share
 * their task directory and see each other's task owners, as hosts on one machine do.
 */
const start = (name, { env, user, capDrop = [], command = [] }) => {
  containers.add(name);
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "host",
    "--pid",
    "host",
    ...(user === undefined ? [] : ["--user", user]),
    ...capDrop.flatMap((capability) => ["--cap-drop", capability]),
    "--volume",
    `${temporary}/ca.pem:/run/patchy-ca.pem:ro`,
    "--volume",
    `${temporary}/tasks:/tasks`,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    image,
    ...command
  );
};
const running = (name) => docker("inspect", "--format", "{{.State.Running}}", name) === "true";
const logs = (name) => {
  try {
    return execFileSync("docker", ["logs", name], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    return String(error);
  }
};
const healthy = async (name, port) => {
  const started = Date.now();
  await until(`${name} did not answer /healthz`, async () => {
    if (!running(name)) throw new Error(`${name} exited before it served:\n${logs(name)}`);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_000)
    }).catch(() => undefined);
    return response?.status === 200;
  });
  return Date.now() - started;
};
/** A one-off container run to completion, as the deploy runs its promote task. */
const once = (env, command) =>
  new Promise((resolve, reject) => {
    const args = ["run", "--rm", "--network", "host", "--volume"];
    args.push(`${temporary}/ca.pem:/run/patchy-ca.pem:ro`);
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    const child = spawn("docker", [...args, image, ...command], { stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output: output.trim() }));
  });
/** SIGTERM, as `docker stop` and ECS send it; 137 means it was killed at the deadline instead. */
const stop = (name) => {
  const started = Date.now();
  docker("stop", "--time", "30", name);
  const code = Number(docker("inspect", "--format", "{{.State.ExitCode}}", name));
  if (code === 137) throw new Error(`${name} ignored SIGTERM until it was killed:\n${logs(name)}`);
  return { code, ms: Date.now() - started };
};

let postgres;
try {
  // A scratch CA, and a certificate that names only `localhost`.
  const openssl = (...args) =>
    execFileSync("openssl", args, { cwd: temporary, stdio: ["ignore", "ignore", "inherit"] });
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...key,
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=smoke CA"
  );
  openssl("req", ...key, "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost");
  await writeFile(path.join(temporary, "server.ext"), "subjectAltName=DNS:localhost\n");
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.pem",
    "-days",
    "1",
    "-extfile",
    "server.ext"
  );
  await chmod(path.join(temporary, "server.key"), 0o600);
  await chmod(path.join(temporary, "ca.pem"), 0o644);
  // Hosts run as uid 1000 and share this directory, as hosts on one machine would.
  await mkdir(path.join(temporary, "tasks"), { mode: 0o777 });
  await chmod(path.join(temporary, "tasks"), 0o777);

  const password = `smoke-${Date.now()}`;
  const pgPort = await freePort();
  const pgDirectory = path.join(temporary, "postgres");
  postgres = new EmbeddedPostgres({
    databaseDir: pgDirectory,
    port: pgPort,
    user: "postgres",
    password,
    authMethod: "scram-sha-256",
    persistent: false,
    postgresFlags: [
      "-c",
      "fsync=off",
      "-c",
      "ssl=on",
      "-c",
      `ssl_cert_file=${path.join(temporary, "server.pem")}`,
      "-c",
      `ssl_key_file=${path.join(temporary, "server.key")}`
    ],
    onLog: () => {},
    onError: () => {}
  });
  await postgres.initialise();
  // TCP only over TLS and only with SCRAM; plaintext is refused.
  await writeFile(
    path.join(pgDirectory, "pg_hba.conf"),
    [
      "local all all scram-sha-256",
      "hostssl all all 127.0.0.1/32 scram-sha-256",
      "hostssl all all ::1/128 scram-sha-256",
      "host all all all reject",
      ""
    ].join("\n")
  );
  await postgres.start();
  const admin = new pg.Client({
    host: "localhost",
    port: pgPort,
    user: "postgres",
    password,
    database: "postgres",
    ssl: { ca: await readFile(path.join(temporary, "ca.pem"), "utf8") }
  });
  await admin.connect();
  await admin.query("CREATE DATABASE patchy");
  await admin.end();
  const url = (database, host = "localhost", sslmode = "verify-full") =>
    `postgresql://postgres:${password}@${host}:${pgPort}/${database}?sslmode=${sslmode}`;

  const [portA, portB, callbackA, callbackB] = await Promise.all(
    Array.from({ length: 4 }, freePort)
  );
  const callbackUrls = JSON.stringify(
    [callbackA, callbackB].map((port) => `http://127.0.0.1:${port}/callback`)
  );
  // Development, because production refuses local tasks; the runtime, user and image are production's.
  const shared = {
    ...clerkEnv(),
    NODE_ENV: "development",
    NODE_EXTRA_CA_CERTS: "/run/patchy-ca.pem",
    DATABASE_URL: url("patchy"),
    PATCHY_COMPANY_DB_ADMIN_URL: url("postgres"),
    PATCHY_COMPANY_DB_URL: url("patchy"),
    PATCHY_CREDENTIAL_KEYS: `smoke:${Buffer.alloc(32, 3).toString("base64")}`,
    PATCHY_LIMITS_JSON: JSON.stringify({ "execution.fleet.budget": 6, "execution.pool.spares": 1 })
  };
  const host = (port, callbackPort, revision) => ({
    ...shared,
    PORT: String(port),
    PATCHY_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PATCHY_DEPLOYMENT_REVISION: revision,
    EXECUTION_PROVIDER: "local-fleet",
    EXECUTION_LOCAL_DIRECTORY: "/tasks",
    EXECUTION_CALLBACK_PORT: String(callbackPort),
    EXECUTION_CALLBACK_URLS: callbackUrls
  });

  // 1. The default command and user, against TLS and SCRAM.
  start("smoke-host-a", { env: host(portA, callbackA, "smoke-a") });
  say(`host a (smoke-a) served /healthz ${await healthy("smoke-host-a", portA)} ms after start`);
  const identity = docker("top", "smoke-host-a", "-o", "uid,comm");
  if (!/^\s*1000\s+bun\b/m.test(identity))
    throw new Error(`The host should run Bun as uid 1000:\n${identity}`);
  start("smoke-host-b", { env: host(portB, callbackB, "smoke-b") });
  say(`host b (smoke-b) served /healthz ${await healthy("smoke-host-b", portB)} ms after start`);
  for (const [label, database] of [
    ["by IP, which the certificate does not name", url("patchy", "127.0.0.1")],
    ["without TLS", url("patchy", "localhost", "disable")]
  ]) {
    const refused = await once({ ...shared, DATABASE_URL: database }, [
      "bun",
      "dist/fleet.js",
      "promote",
      "smoke-a"
    ]);
    if (refused.code === 0) throw new Error(`Postgres accepted a connection ${label}.`);
    say(`connecting ${label} is refused`);
  }

  // 2. Promotion and the rollback, as the deploy runs them: a one-off task beside the hosts.
  for (const revision of ["smoke-b", "smoke-a"]) {
    const promoted = await once(shared, ["bun", "dist/fleet.js", "promote", revision]);
    if (
      promoted.code !== 0 ||
      !promoted.output.includes(`Promoted deployment revision ${revision}.`)
    )
      throw new Error(`Promoting ${revision} failed (${promoted.code}):\n${promoted.output}`);
    say(`promoted ${revision}`);
  }

  // 3. SIGTERM.
  for (const name of ["smoke-host-b", "smoke-host-a"]) {
    const stopped = stop(name);
    say(`${name} exited ${stopped.code} ${stopped.ms} ms after SIGTERM`);
  }

  // 4. The exec supervisor, as AppStack.ts defines the task: root, fewer capabilities.
  const managementPort = await freePort();
  start("smoke-exec", {
    user: "0",
    capDrop: [
      "NET_RAW",
      "NET_BIND_SERVICE",
      "SYS_CHROOT",
      "MKNOD",
      "SETFCAP",
      "SETPCAP",
      "AUDIT_WRITE",
      "FSETID"
    ],
    command: ["bun", "dist/exec.js"],
    env: {
      EXECUTION_MANAGEMENT_SECRET: "smoke-management-secret-0123456789",
      EXECUTION_MANAGEMENT_PORT: String(managementPort),
      EXECUTION_CALLBACK_URLS: "[]",
      EXECUTION_DEPLOYMENT_REVISION: "smoke-a",
      EXECUTION_TASK_ID: "smoke-task"
    }
  });
  let processes = "";
  await until("The exec supervisor did not start its standby workerd as another uid", () => {
    if (!running("smoke-exec")) throw new Error(`The exec task exited:\n${logs("smoke-exec")}`);
    processes = docker("top", "smoke-exec", "-o", "uid,args");
    return (
      /^\s*0\s+bun dist\/exec\.js/m.test(processes) &&
      /^\s*[1-9]\d*\s+\S*\s*serve /m.test(processes)
    );
  });
  say(
    `the exec supervisor runs as root and workerd as uid ${/^\s*([1-9]\d*)\s+\S*\s*serve /m.exec(processes)[1]}`
  );
  const exec = stop("smoke-exec");
  say(`smoke-exec exited ${exec.code} ${exec.ms} ms after SIGTERM`);

  // 5. Older releases' hosts start exec tasks with `node dist/exec.js`; in this image it is Bun.
  const fallback = await once({}, ["node", "-e", "console.log(process.versions.bun)"]);
  if (fallback.code !== 0 || fallback.output !== bunVersion)
    throw new Error(`\`node\` in the image should run Bun ${bunVersion}: ${fallback.output}`);
  say(`\`node\` runs Bun ${fallback.output}`);
  say("passed");
} catch (error) {
  for (const name of containers)
    console.error(`--- ${name}\n${logs(name).split("\n").slice(-40).join("\n")}`);
  throw error;
} finally {
  for (const name of containers) {
    try {
      docker("rm", "--force", "--volumes", name);
    } catch {}
  }
  await postgres?.stop().catch(() => undefined);
  // Task files the hosts wrote as uid 1000 may refuse this user; CI's runner is discarded anyway.
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
}
