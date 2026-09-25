// PROTOTYPE for #311: the execution task's supervisor. Owns the workerd child,
// proxies /bind and /invoke to it on localhost, reads its RSS from /proc, and
// kills + restarts it when an invocation overruns its wall-clock budget or RSS
// crosses the bound. Listens on 8080, the only port the security groups allow.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
// The npm bin is a Node shim; spawn the real binary so kill() hits workerd itself.
const WORKERD = join(here, "node_modules", "@cloudflare", "workerd-linux-64", "bin", "workerd");
const WORKERD_PORT = Number(process.env.WORKERD_PORT ?? 8787);
const WORKERD_URL = `http://127.0.0.1:${WORKERD_PORT}`;
const RSS_LIMIT_MB = Number(process.env.RSS_LIMIT_MB ?? 512);
const startedAt = Date.now();

type InFlight = {
  id: string;
  handler: string;
  budgetMs: number;
  startedAt: number;
  reject: (e: Error) => void;
};
let child: ChildProcess | undefined;
let generation = 0;
let ready: Promise<void> = Promise.resolve();
const inFlight = new Map<string, InFlight>();
const kills: Array<{
  at: number;
  reason: string;
  generation: number;
  inFlight: string[];
  restartMs?: number;
  detail?: string;
}> = [];

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
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startWorkerd() {
  generation++;
  const t0 = Date.now();
  child = spawn(
    WORKERD,
    [
      "serve",
      join(here, "config.capnp"),
      "--experimental",
      `--socket-addr=http=127.0.0.1:${WORKERD_PORT}`
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  const pid = child.pid;
  child.on("exit", (code, signal) =>
    console.log(`[supervisor] workerd pid ${pid} exited code=${code} signal=${signal}`)
  );
  ready = waitFor(`${WORKERD_URL}/healthz`, 15000).then(
    (ms) =>
      console.log(`[supervisor] workerd generation ${generation} pid ${pid} ready in ${ms} ms`),
    (e) => {
      console.log(
        `[supervisor] workerd generation ${generation} failed to start (${e.message}); retrying`
      );
      child?.kill("SIGKILL");
      startWorkerd();
      return ready;
    }
  );
  return t0;
}

function kill(reason: string, detail?: string) {
  const victims = [...inFlight.values()];
  const rec = {
    at: Date.now(),
    reason,
    generation,
    inFlight: victims.map((v) => `${v.id}:${v.handler}`),
    detail
  };
  kills.push(rec);
  console.log(
    `[supervisor] KILL workerd: ${reason} ${detail ?? ""} in-flight=${rec.inFlight.join(",")}`
  );
  for (const v of victims) v.reject(new Error(`watchdog_killed:${reason}`));
  inFlight.clear();
  const t0 = Date.now();
  const old = child!;
  // Respawn only once the old process is gone, or the port is still held.
  ready = new Promise<void>((resolve) => {
    old.once("exit", () => {
      startWorkerd();
      ready.then(() => {
        rec.restartMs = Date.now() - t0;
        resolve();
      });
    });
  });
  old.kill("SIGKILL");
}

// Watchdog: wall-clock per invocation and RSS bound, checked every 100 ms.
setInterval(() => {
  const now = Date.now();
  for (const v of inFlight.values()) {
    if (now - v.startedAt > v.budgetMs)
      return kill("wall_clock", `${v.handler} ran ${now - v.startedAt} ms > ${v.budgetMs} ms`);
  }
  const rss = rssMB(child?.pid);
  if (rss > RSS_LIMIT_MB) return kill("rss", `${rss} MB > ${RSS_LIMIT_MB} MB`);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/healthz") {
      await ready;
      const r = await fetch(`${WORKERD_URL}/healthz`, { signal: AbortSignal.timeout(1000) });
      return send(res, r.ok ? 200 : 503, {
        ok: r.ok,
        generation,
        uptimeMs: Date.now() - startedAt
      });
    }
    if (url.pathname === "/stats") {
      return send(res, 200, {
        generation,
        workerdRssMB: rssMB(child?.pid),
        supervisorRssMB: rssMB(process.pid),
        inFlight: inFlight.size,
        kills,
        rssLimitMB: RSS_LIMIT_MB
      });
    }
    if (url.pathname === "/probe") return send(res, 200, await probe());
    if (url.pathname === "/outbound-attempts") {
      const r = await fetch(`${WORKERD_URL}/outbound-attempts`);
      return send(res, 200, await r.json());
    }
    if (url.pathname === "/bind" || url.pathname === "/invoke") {
      await ready;
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const gen = generation;
      const t0 = Date.now();
      const forward = fetch(`${WORKERD_URL}${url.pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw
      });
      let result: Response;
      if (url.pathname === "/invoke") {
        const killed = new Promise<never>((_, reject) => {
          inFlight.set(body.invocationId, {
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
            generation,
            kill: k,
            execMs: Date.now() - t0
          });
        } finally {
          inFlight.delete(body.invocationId);
        }
      } else {
        result = await forward;
      }
      const out = await result.json();
      return send(res, result.status, { ...out, generation: gen, execMs: Date.now() - t0 });
    }
    send(res, 404, { error: "not_found" });
  } catch (e: any) {
    send(res, 500, { ok: false, error: String(e?.message ?? e), generation });
  }
});

startWorkerd();
server.listen(PORT, () =>
  console.log(
    `[supervisor] listening on ${PORT}, workerd at ${WORKERD_URL}, rss limit ${RSS_LIMIT_MB} MB`
  )
);
