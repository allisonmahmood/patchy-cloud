// PROTOTYPE for #311: the execution task's supervisor. Owns the workerd
// processes, proxies /bind and /invoke to them on localhost, reads RSS from
// /proc, and kills + restarts a process when an invocation overruns its
// wall-clock budget or RSS crosses the bound. Listens on 8080.
//
// Round 2: PROCESS_MODE=company runs one workerd for every patch version of
// the company (round 1); PROCESS_MODE=patch runs one workerd per loaded
// company/patch@version, reaped after PROCESS_IDLE_MS idle. Every management
// request needs the shared secret and carries the host's owner epoch; an
// epoch lower than the highest seen is refused as stale.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
// The npm bin is a Node shim; spawn the real binary so kill() hits workerd itself.
const WORKERD = join(here, "node_modules", "@cloudflare", "workerd-linux-64", "bin", "workerd");
const BASE_PORT = Number(process.env.WORKERD_PORT ?? 8787);
const RSS_LIMIT_MB = Number(process.env.RSS_LIMIT_MB ?? 512);
const MODE = (process.env.PROCESS_MODE ?? "company") as "company" | "patch";
const PROCESS_IDLE_MS = Number(process.env.PROCESS_IDLE_MS ?? 60_000);
const SECRET = process.env.EXEC_SECRET ?? "";
const startedAt = Date.now();

type InFlight = {
  id: string;
  handler: string;
  budgetMs: number;
  startedAt: number;
  reject: (e: Error) => void;
};
type Proc = {
  name: string; // "*" in company mode, the worker name in patch mode
  port: number;
  child?: ChildProcess;
  generation: number;
  ready: Promise<void>;
  inFlight: Map<string, InFlight>;
  lastUsed: number;
  spawnedAt: number;
  spawnMs?: number;
};
const procs = new Map<string, Proc>();
let nextPort = BASE_PORT;
let highestEpoch = 0;
const kills: Array<{
  at: number;
  proc: string;
  reason: string;
  generation: number;
  inFlight: string[];
  restartMs?: number;
  detail?: string;
}> = [];
const reaped: Array<{ at: number; proc: string; idleMs: number }> = [];
const rejected: Array<{ at: number; why: string; path: string }> = [];

function rssMB(pid: number | undefined) {
  if (!pid) return 0;
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch {
    return 0;
  }
}

async function waitFor(url: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return Date.now() - t0;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`workerd did not come up in ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function spawnWorkerd(p: Proc) {
  p.generation++;
  const t0 = Date.now();
  const child = spawn(
    WORKERD,
    [
      "serve",
      join(here, "config.capnp"),
      "--experimental",
      `--socket-addr=http=127.0.0.1:${p.port}`
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  p.child = child;
  const pid = child.pid;
  child.on("exit", (code, signal) =>
    console.log(`[supervisor] ${p.name} workerd pid ${pid} exited code=${code} signal=${signal}`)
  );
  p.ready = waitFor(`http://127.0.0.1:${p.port}/healthz`, 15000).then(
    (ms) => {
      p.spawnMs = Date.now() - t0;
      console.log(
        `[supervisor] ${p.name} generation ${p.generation} pid ${pid} port ${p.port} ready in ${ms} ms`
      );
    },
    (e) => {
      console.log(
        `[supervisor] ${p.name} generation ${p.generation} failed to start (${e.message}); retrying`
      );
      child.kill("SIGKILL");
      spawnWorkerd(p);
      return p.ready;
    }
  );
  return t0;
}

function procFor(name: string, create = true): Proc | undefined {
  const key = MODE === "company" ? "*" : name;
  let p = procs.get(key);
  if (!p && create) {
    p = {
      name: key,
      port: nextPort++,
      generation: 0,
      ready: Promise.resolve(),
      inFlight: new Map(),
      lastUsed: Date.now(),
      spawnedAt: Date.now()
    };
    procs.set(key, p);
    spawnWorkerd(p);
  }
  return p;
}

function kill(p: Proc, reason: string, detail?: string) {
  const victims = [...p.inFlight.values()];
  const rec = {
    at: Date.now(),
    proc: p.name,
    reason,
    generation: p.generation,
    inFlight: victims.map((v) => `${v.id}:${v.handler}`),
    detail
  };
  kills.push(rec);
  console.log(
    `[supervisor] KILL ${p.name}: ${reason} ${detail ?? ""} in-flight=${rec.inFlight.join(",")}`
  );
  for (const v of victims) v.reject(new Error(`watchdog_killed:${reason}`));
  p.inFlight.clear();
  const t0 = Date.now();
  const old = p.child!;
  // Respawn only once the old process is gone, or the port is still held.
  p.ready = new Promise<void>((resolve) => {
    old.once("exit", () => {
      spawnWorkerd(p);
      p.ready.then(() => {
        rec.restartMs = Date.now() - t0;
        resolve();
      });
    });
  });
  old.kill("SIGKILL");
}

function reap(p: Proc) {
  const idleMs = Date.now() - p.lastUsed;
  reaped.push({ at: Date.now(), proc: p.name, idleMs });
  console.log(`[supervisor] REAP ${p.name} after ${idleMs} ms idle`);
  procs.delete(p.name);
  p.child?.kill("SIGKILL");
}

// Watchdog: wall-clock per invocation and RSS bound per process, every 100 ms;
// in patch mode also the idle reaper.
setInterval(() => {
  const now = Date.now();
  for (const p of procs.values()) {
    for (const v of p.inFlight.values()) {
      if (now - v.startedAt > v.budgetMs) {
        kill(p, "wall_clock", `${v.handler} ran ${now - v.startedAt} ms > ${v.budgetMs} ms`);
        break;
      }
    }
    const rss = rssMB(p.child?.pid);
    if (rss > RSS_LIMIT_MB) kill(p, "rss", `${rss} MB > ${RSS_LIMIT_MB} MB`);
    if (MODE === "patch" && p.inFlight.size === 0 && now - p.lastUsed > PROCESS_IDLE_MS) reap(p);
  }
}, 100);

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function probe() {
  const tryFetch = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return { url, status: r.status, body: (await r.text()).slice(0, 80) };
    } catch (e: any) {
      return { url, error: `${e?.name}: ${e?.cause?.code ?? e?.message}` };
    }
  };
  return {
    metadata: await tryFetch(
      `${process.env.ECS_CONTAINER_METADATA_URI_V4 ?? "http://169.254.170.2/v4"}/task`
    ),
    imds: await tryFetch("http://169.254.169.254/latest/meta-data/"),
    credentials: await tryFetch(
      `http://169.254.170.2${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? "/v2/credentials"}`
    ),
    internet: await tryFetch("https://example.com"),
    passwd: existsSync("/etc/passwd")
      ? readFileSync("/etc/passwd", "utf8").split("\n")[0]
      : "missing",
    env: Object.keys(process.env).filter((k) => k.startsWith("AWS") || k.startsWith("ECS"))
  };
}

function stats() {
  const list = [...procs.values()].map((p) => ({
    proc: p.name,
    port: p.port,
    pid: p.child?.pid,
    generation: p.generation,
    rssMB: rssMB(p.child?.pid),
    inFlight: p.inFlight.size,
    idleMs: Date.now() - p.lastUsed,
    spawnMs: p.spawnMs
  }));
  const workerdRssMB = list.reduce((a, p) => a + p.rssMB, 0);
  const supervisorRssMB = rssMB(process.pid);
  return {
    mode: MODE,
    processIdleMs: PROCESS_IDLE_MS,
    processes: list.length,
    workerdRssMB,
    supervisorRssMB,
    aggregateRssMB: workerdRssMB + supervisorRssMB,
    procs: list,
    kills,
    reaped,
    rejected: rejected.slice(-20),
    highestEpoch,
    rssLimitMB: RSS_LIMIT_MB,
    generation: MODE === "company" ? procs.get("*")?.generation : undefined
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/healthz")
      return send(res, 200, {
        ok: true,
        mode: MODE,
        processes: procs.size,
        uptimeMs: Date.now() - startedAt
      });
    // Everything below is management: shared secret, then the owner-epoch fence.
    if (SECRET && req.headers["x-exec-secret"] !== SECRET) {
      rejected.push({ at: Date.now(), why: "bad_secret", path: url.pathname });
      return send(res, 401, { error: "unauthorized" });
    }
    const epoch = Number(req.headers["x-owner-epoch"] ?? 0);
    if (epoch < highestEpoch) {
      rejected.push({
        at: Date.now(),
        why: `stale_epoch ${epoch} < ${highestEpoch}`,
        path: url.pathname
      });
      return send(res, 412, { error: "stale_epoch", epoch, highestEpoch });
    }
    if (epoch > highestEpoch) {
      console.log(`[supervisor] owner epoch ${highestEpoch} -> ${epoch}`);
      highestEpoch = epoch;
    }
    if (url.pathname === "/epoch")
      return send(res, 200, { highestEpoch, mode: MODE, processes: procs.size });
    if (url.pathname === "/stats") return send(res, 200, stats());
    if (url.pathname === "/probe") return send(res, 200, await probe());
    if (url.pathname === "/outbound-attempts") {
      const all = [];
      for (const p of procs.values())
        all.push(...(await (await fetch(`http://127.0.0.1:${p.port}/outbound-attempts`)).json()));
      return send(res, 200, all);
    }
    if (url.pathname === "/bind" || url.pathname === "/invoke") {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const p = procFor(body.name)!;
      await p.ready;
      const gen = p.generation;
      const t0 = Date.now();
      p.lastUsed = t0;
      // The loader stamps callbacks with the process generation the attempt started on.
      const forward = fetch(`http://127.0.0.1:${p.port}${url.pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, generation: gen })
      });
      let result: Response;
      if (url.pathname === "/invoke") {
        const killed = new Promise<never>((_, reject) => {
          p.inFlight.set(body.invocationId, {
            id: body.invocationId,
            handler: body.handler,
            budgetMs: body.budgetMs ?? 5000,
            startedAt: t0,
            reject
          });
        });
        try {
          result = await Promise.race([forward, killed]);
        } catch (e: any) {
          const k = kills[kills.length - 1];
          return send(res, 503, {
            ok: false,
            error: String(e.message),
            generation: p.generation,
            mode: MODE,
            proc: p.name,
            kill: k,
            execMs: Date.now() - t0
          });
        } finally {
          p.inFlight.delete(body.invocationId);
          p.lastUsed = Date.now();
        }
      } else {
        result = await forward;
      }
      const out = await result.json();
      return send(res, result.status, {
        ...out,
        generation: gen,
        mode: MODE,
        proc: p.name,
        spawnMs: p.spawnMs,
        execMs: Date.now() - t0
      });
    }
    send(res, 404, { error: "not_found" });
  } catch (e: any) {
    send(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

if (MODE === "company") procFor("*");
server.listen(PORT, () =>
  console.log(
    `[supervisor] listening on ${PORT}, mode ${MODE}, rss limit ${RSS_LIMIT_MB} MB, secret ${SECRET ? "set" : "NOT set"}`
  )
);
