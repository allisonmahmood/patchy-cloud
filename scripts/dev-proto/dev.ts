/**
 * PROTOTYPE — throwaway. Answers "Dev runner supervisor prototype" (#27):
 * should the dev runner supervise `turbo run dev`, or spawn each service
 * itself with Effect 4's ChildProcess?
 *
 *   tsx scripts/dev-proto/dev.ts <turbo|effect> <up|start|stop|status|logs|dry-run>
 *
 *   up       foreground supervisor — Ctrl-C teardown test
 *   start    daemonised supervisor, returns when /healthz answers
 *   stop     SIGTERM the supervisor recorded in plan.json, report leftovers
 *   status   what's alive (supervisor / server port / postgres pid)
 *   logs     print .local/dev/dev.log
 *   dry-run  print the Plan, no side effects
 *
 * Both variants start embedded-postgres in-process the same way; they differ
 * only in how the server is launched. Everything lives in <worktree>/.local/dev/.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import EmbeddedPostgres from "embedded-postgres";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Variant = "turbo" | "effect";
const [variant, cmd] = process.argv.slice(2) as [Variant, string];
if (!["turbo", "effect"].includes(variant) || !cmd) {
  console.error("usage: dev.ts <turbo|effect> <up|start|stop|status|logs|dry-run|supervise>");
  process.exit(2);
}

// ---- Plan -------------------------------------------------------------------
const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const hash = parseInt(createHash("sha256").update(root).digest("hex").slice(0, 6), 16);
const base = 20000 + (hash % 20000) * 2;
const stateDir = path.join(root, ".local", "dev");
const plan = {
  variant,
  root,
  stateDir,
  serverPort: base,
  pgPort: base + 1,
  pgDir: path.join(stateDir, "pg"),
  logFile: path.join(stateDir, "dev.log"),
  planFile: path.join(stateDir, "plan.json"),
  databaseUrl: `postgres://postgres:password@127.0.0.1:${base + 1}/patchy`,
  pids: { supervisor: 0, service: 0, postgres: 0 }
};
type Plan = typeof plan;

const serverEnv = {
  PORT: String(plan.serverPort),
  DATABASE_URL: plan.databaseUrl,
  PATCHY_STORAGE_DIR: path.join(stateDir, "storage"),
  PATCHY_BOOTSTRAP_API_TOKEN: "dev-token",
  PATCHY_PUBLIC_BASE_URL: `http://127.0.0.1:${plan.serverPort}`
};

const readPlan = (): Plan | undefined =>
  fs.existsSync(plan.planFile) ? JSON.parse(fs.readFileSync(plan.planFile, "utf8")) : undefined;
const writePlan = (p: Plan) => fs.writeFileSync(plan.planFile, JSON.stringify(p, null, 2));
const alive = (pid: number) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const postmasterPid = () => {
  const f = path.join(plan.pgDir, "postmaster.pid");
  return fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8").split("\n")[0]) : 0;
};
// Every process whose cmdline mentions this worktree's state — the orphan detector.
const strays = () => {
  const out = spawnSync("pgrep", ["-af", root + "/"], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").filter((l) => l && !l.includes("pgrep") && !l.includes("dev-proto/dev.ts " + variant + " st"));
};
const healthy = async () => {
  try { return (await fetch(`http://127.0.0.1:${plan.serverPort}/healthz`)).ok; } catch { return false; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Supervisor (the thing under test) --------------------------------------
const supervise = Effect.gen(function* () {
  fs.mkdirSync(plan.pgDir, { recursive: true });
  const log = fs.createWriteStream(plan.logFile, { flags: "a" });
  const line = (tag: string, s: string) => log.write(`${new Date().toISOString().slice(11, 23)} ${tag} ${s}\n`);
  line("[sup]", `supervisor pid=${process.pid} variant=${variant}`);

  // Postgres: same in both variants, so it's a plain acquireRelease.
  const pg = new EmbeddedPostgres({
    databaseDir: plan.pgDir,
    port: plan.pgPort,
    onLog: (m) => line("[pg]", String(m).trim()),
    onError: (m) => line("[pg!]", String(m).trim())
  });
  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      if (!fs.existsSync(path.join(plan.pgDir, "PG_VERSION"))) await pg.initialise();
      await pg.start();
      await pg.createDatabase("patchy").catch(() => {});
      line("[sup]", `postgres up pid=${postmasterPid()} port=${plan.pgPort}`);
    }),
    () => Effect.promise(async () => { await pg.stop(); line("[sup]", "postgres stopped"); })
  );

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command =
    variant === "turbo"
      ? ChildProcess.make("turbo", ["run", "dev", "--parallel", "--env-mode=loose"], { cwd: root, env: serverEnv, extendEnv: true })
      : ChildProcess.make("tsx", ["watch", "src/start.ts"], { cwd: path.join(root, "apps/server"), env: serverEnv, extendEnv: true });
  // forceKillAfter: SIGTERM, then SIGKILL if it lingers.
  const handle = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, { ...command.options, killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
  );
  const tag = variant === "turbo" ? "[turbo]" : "[server]";
  line("[sup]", `${tag} spawned pid=${handle.pid}`);
  writePlan({ ...plan, pids: { supervisor: process.pid, service: handle.pid, postgres: postmasterPid() } });

  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((l) => Effect.sync(() => line(tag, l))),
    Effect.forkScoped
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => line("[sup]", "teardown: scope closing")));
  // Service exit ends the supervisor (and so tears postgres down with it).
  const code = yield* handle.exitCode;
  line("[sup]", `${tag} exited code=${code}`);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// ---- Commands ---------------------------------------------------------------
const self = fileURLToPath(import.meta.url);

const start = Effect.gen(function* () {
  fs.mkdirSync(stateDir, { recursive: true });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("tsx", [self, variant, "supervise"], { cwd: root, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", extendEnv: true })
  );
  yield* handle.unref;
  console.log(`supervisor pid=${handle.pid}, waiting for http://127.0.0.1:${plan.serverPort}/healthz`);
  for (let i = 0; i < 300; i++) {
    if (yield* Effect.promise(healthy)) { console.log("healthy"); return; }
    if (!alive(handle.pid)) { console.log("supervisor died — see logs"); process.exitCode = 1; return; }
    yield* Effect.sleep("200 millis");
  }
  console.log("timed out"); process.exitCode = 1;
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const status = () => {
  const p = readPlan();
  console.log(JSON.stringify({
    supervisor: p ? { pid: p.pids.supervisor, alive: alive(p.pids.supervisor) } : null,
    service: p ? { pid: p.pids.service, alive: alive(p.pids.service) } : null,
    postgres: { pid: postmasterPid(), alive: alive(postmasterPid()) },
    strays: strays()
  }, null, 2));
};

const stop = async () => {
  const p = readPlan();
  if (!p || !alive(p.pids.supervisor)) { console.log("no live supervisor"); }
  else {
    process.kill(p.pids.supervisor, "SIGTERM");
    for (let i = 0; i < 100 && alive(p.pids.supervisor); i++) await sleep(100);
    console.log(alive(p.pids.supervisor) ? "supervisor still alive after 10s" : "supervisor exited");
  }
  await sleep(500);
  console.log("server port answers:", await healthy());
  console.log("leftovers:", strays());
};

switch (cmd) {
  case "dry-run": console.log(JSON.stringify(plan, null, 2)); break;
  case "supervise":
  case "up":
    if (cmd === "up") console.log(`foreground; logs -> ${plan.logFile}`);
    NodeRuntime.runMain(supervise);
    break;
  case "start": NodeRuntime.runMain(start); break;
  case "stop": await stop(); break;
  case "status": status(); break;
  case "logs": console.log(fs.existsSync(plan.logFile) ? fs.readFileSync(plan.logFile, "utf8") : "(no log)"); break;
  default: console.error("unknown command", cmd); process.exit(2);
}
