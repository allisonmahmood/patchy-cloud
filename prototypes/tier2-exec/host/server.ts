// PROTOTYPE for #311: stub of Patchy's runtime host as one Node process.
// /invoke picks the company's bound exec task and calls it; /callback runs
// table operations with a per-invocation capability, one SERIALIZABLE
// transaction per mutation opened on the first callback; /stream is SSE.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { pool as db, migrate, reset, tableOp, warm } from "./db.ts";
import * as pool from "./pool.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const DEADLINE_MS = 5000;
// The exec watchdog fires before the host deadline so its kill is what the host sees.
const WATCHDOG_MS = 4500;
const ACTION_BUDGET_MS = 30_000;
const SLOTS = Number(process.env.SLOTS ?? 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bundles and manifest produced by handlers/build.mjs, copied in by infra/build.sh.
const bundlesDir = join(here, "bundles");
const manifest: Record<string, "query" | "mutation"> = JSON.parse(
  readFileSync(join(bundlesDir, "manifest.json"), "utf8")
);
const bundles = Object.fromEntries(
  readdirSync(bundlesDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => [f.replace(/\.js$/, ""), readFileSync(join(bundlesDir, f), "utf8")])
);

// The host's own address as exec tasks reach it (private VPC IP on Fargate).
let hostUrl = process.env.HOST_URL ?? `http://127.0.0.1:${PORT}`;
async function discoverHostUrl() {
  const meta = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!meta) return;
  const t = await (await fetch(`${meta}/task`)).json();
  const ip = t.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0];
  if (ip) hostUrl = `http://${ip}:${PORT}`;
}

type Invocation = {
  id: string;
  attempt: number;
  capability: string;
  company: string;
  kind: "query" | "mutation";
  principal: string;
  deadlineAt: number;
  client?: pg.PoolClient;
  txOpenedAt?: number;
  failed?: string;
  serializationFailure?: boolean;
  ended: boolean;
  callbacks: Array<{ op: string; ms: number; sqlMs: number; at: number }>;
};
const byCapability = new Map<string, Invocation>();
const endedCapabilities = new Map<string, string>(); // capability -> why refused
const inFlight = new Map<string, number>(); // company -> slots in use

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

async function rollback(inv: Invocation) {
  const c = inv.client;
  if (!c) return;
  inv.client = undefined;
  try {
    await c.query("ROLLBACK");
  } catch {}
  c.release();
}

// ---- /callback: the capability broker's far end -------------------------
async function callback(req: IncomingMessage, res: ServerResponse) {
  const t0 = Date.now();
  const cap = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const inv = byCapability.get(cap);
  if (!inv)
    return send(res, 403, {
      error: "capability_refused",
      reason: endedCapabilities.get(cap) ?? "unknown_capability"
    });
  if (inv.failed) return send(res, 409, { error: "attempt_aborted", reason: inv.failed });
  const { op, args } = JSON.parse(await readBody(req));
  if (op === "util.sleep") {
    await sleep(Math.min(args.ms, 10_000));
    inv.callbacks.push({ op, ms: Date.now() - t0, sqlMs: 0, at: t0 });
    return send(res, 200, { result: null });
  }
  if (inv.kind === "query" && op !== "tables.list") {
    inv.failed = "query_cannot_write";
    return send(res, 403, { error: "query_cannot_write" });
  }
  try {
    let q: { query: pg.Pool["query"] } = db;
    if (inv.kind === "mutation") {
      if (!inv.client) {
        inv.client = await db.connect();
        inv.txOpenedAt = Date.now();
        await inv.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await inv.client.query(
          `SET LOCAL statement_timeout = ${Math.max(100, inv.deadlineAt - Date.now())}`
        );
      }
      q = inv.client;
    }
    const s0 = Date.now();
    const result = await tableOp(q, inv.company, inv.principal, op, args);
    await q.query(
      "insert into operations (invocation_id, attempt, op, principal, ms) values ($1, $2, $3, $4, $5)",
      [inv.id, inv.attempt, op, inv.principal, Date.now() - s0]
    );
    const sqlMs = Date.now() - s0;
    inv.callbacks.push({ op, ms: Date.now() - t0, sqlMs, at: t0 });
    send(res, 200, { result, ms: Date.now() - t0, sqlMs });
  } catch (e: any) {
    inv.failed = e.code === "40001" ? "serialization_failure" : `sql_error:${e.code ?? e.message}`;
    if (e.code === "40001") inv.serializationFailure = true;
    inv.callbacks.push({ op: `${op}!${inv.failed}`, ms: Date.now() - t0, sqlMs: 0, at: t0 });
    send(res, 409, { error: inv.failed, detail: e.message });
  }
}

// ---- /invoke ------------------------------------------------------------
async function invoke(req: IncomingMessage, res: ServerResponse) {
  const t0 = Date.now();
  const body = JSON.parse(await readBody(req));
  const {
    company,
    patch = "crm",
    version = "v1",
    handler,
    args = {},
    as = "viewer",
    limits
  } = body;
  const viewer = String(req.headers["x-viewer"] ?? "anonymous");
  const kind = manifest[handler];
  if (!kind || !bundles[version])
    return send(res, 404, { error: "no_such_handler", handler, version });
  const principal =
    as === "viewer"
      ? `user:${viewer}`
      : as === "patch"
        ? `patch:${patch}`
        : `user:${viewer} via patch:${patch}`;

  const slots = inFlight.get(company) ?? 0;
  if (slots >= SLOTS) return send(res, 429, { error: "busy", slots });
  inFlight.set(company, slots + 1);
  const id = randomUUID();
  const name = `${company}/${patch}@${version}`;
  const timing: any = { slotsInUse: slots + 1 };
  const deadlineAt = t0 + DEADLINE_MS;
  let outcome = "unknown";
  let attempts = 0;
  let result: any;
  let error: string | undefined;
  let lastCapability = "";
  let execOut: any;
  try {
    // Bind (the wake path). The mutation transaction never opens while binding.
    const task = await pool.acquire(company, async (t) => {
      const r = await fetch(`${t.url}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, bundle: bundles[version] })
      });
      const out = await r.json();
      if (!out.ok) throw new Error(`bind failed: ${out.error}`);
      t.generation = out.generation;
      t.loaded.add(name);
      timing.bindLoadMs = out.loadMs;
    });
    timing.bindMs = task.times.bindMs;
    timing.boundAfterMs = Date.now() - t0;
    const b0 = Date.now();
    await db.query(
      "insert into invocations (id, company, patch, version, handler, kind, viewer, as_mode, principal, started_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
      [id, company, patch, version, handler, kind, viewer, as, principal]
    );
    timing.beginRowMs = Date.now() - b0;

    for (attempts = 1; attempts <= 3; attempts++) {
      const inv: Invocation = {
        id,
        attempt: attempts,
        capability: randomUUID(),
        company,
        kind,
        principal,
        deadlineAt,
        ended: false,
        callbacks: []
      };
      lastCapability = inv.capability;
      byCapability.set(inv.capability, inv);
      const e0 = Date.now();
      const remaining = deadlineAt - Date.now();
      let r: Response;
      try {
        const call = async (withBundle: boolean) =>
          fetch(`${task.url}/invoke`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              bundle: withBundle ? bundles[version] : undefined,
              invocationId: id,
              capability: inv.capability,
              hostUrl,
              handler,
              args,
              viewer,
              budgetMs: WATCHDOG_MS,
              limits
            }),
            signal: AbortSignal.timeout(Math.max(remaining, 50))
          });
        r = await call(!task.loaded.has(name) || task.generation === undefined);
        if (r.status === 409) r = await call(true); // workerd restarted and forgot the bundle
      } catch (e: any) {
        inv.failed = "host_deadline";
        byCapability.delete(inv.capability);
        endedCapabilities.set(inv.capability, "invocation_ended");
        await rollback(inv);
        outcome = "handler_timeout";
        error = `host deadline ${DEADLINE_MS} ms hit (${e.name})`;
        timing.execMs = Date.now() - e0;
        break;
      }
      execOut = await r.json();
      if (execOut.generation !== undefined && execOut.generation !== task.generation) {
        task.generation = execOut.generation;
        task.loaded.clear();
      }
      task.loaded.add(name);
      task.lastUsed = Date.now();
      if (!task.times.firstInvoke) task.times.firstInvoke = Date.now();
      inv.ended = true;
      byCapability.delete(inv.capability);
      endedCapabilities.set(inv.capability, "invocation_ended");
      timing.execMs = Date.now() - e0;
      timing.execReportedMs = execOut.execMs;
      timing.guestMs = execOut.guestMs;
      timing.firstLoad = execOut.firstLoad;
      timing.callbacks = inv.callbacks.map((c) => ({ op: c.op, ms: c.ms, sqlMs: c.sqlMs }));
      timing.callbackMs = inv.callbacks.reduce((a, c) => a + c.ms, 0);
      timing.sqlMs = inv.callbacks.reduce((a, c) => a + c.sqlMs, 0);

      if (inv.serializationFailure) {
        await rollback(inv);
        timing[`attempt${attempts}`] = "40001";
        if (Date.now() < deadlineAt - 200 && attempts < 3) continue;
        outcome = "serialization_failure";
        error = "serialization failure after retries";
        break;
      }
      if (execOut.ok && !inv.failed) {
        if (inv.client) {
          const c0 = Date.now();
          try {
            await inv.client.query("COMMIT");
            inv.client.release();
            inv.client = undefined;
            timing.commitMs = Date.now() - c0;
          } catch (e: any) {
            timing.commitMs = Date.now() - c0;
            inv.client.release(true);
            inv.client = undefined;
            if (e.code === "40001" && attempts < 3 && Date.now() < deadlineAt - 200) {
              timing[`attempt${attempts}`] = "40001@commit";
              continue;
            }
            outcome = e.code === "40001" ? "serialization_failure" : "commit_error";
            error = e.message;
            break;
          }
        }
        outcome = "committed";
        result = execOut.result;
        break;
      }
      await rollback(inv);
      outcome = execOut.error?.startsWith("watchdog_killed")
        ? "watchdog_killed"
        : inv.failed
          ? `callback_failed:${inv.failed}`
          : "handler_failed";
      error = execOut.error ?? inv.failed;
      timing.kill = execOut.kill;
      break;
    }
  } catch (e: any) {
    outcome = "host_error";
    error = e.message;
  } finally {
    inFlight.set(company, (inFlight.get(company) ?? 1) - 1);
  }
  timing.totalMs = Date.now() - t0;
  db.query(
    "update invocations set attempts = $2, outcome = $3, ended_at = now(), timing = $4 where id = $1",
    [id, attempts, outcome, timing]
  ).catch(() => {});
  send(res, outcome === "committed" ? 200 : outcome === "handler_timeout" ? 504 : 500, {
    ok: outcome === "committed",
    id,
    outcome,
    attempts: Math.min(attempts, 3),
    result,
    error,
    principal,
    timing,
    debug: { capability: lastCapability }
  });
}

// ---- admin + stream -----------------------------------------------------
async function execFor(company: string) {
  const t = pool.tasks.find((t) => t.state === "bound" && t.company === company);
  if (!t) throw new Error(`no task bound for ${company}`);
  return t;
}

async function admin(url: URL, req: IncomingMessage, res: ServerResponse) {
  const company = url.searchParams.get("company") ?? "acme";
  switch (url.pathname) {
    case "/admin/pool":
      return send(res, 200, pool.snapshot());
    case "/admin/release":
      await pool.release(company);
      return send(res, 200, { released: company });
    case "/admin/reset":
      await reset(company);
      return send(res, 200, { reset: company });
    case "/admin/rows": {
      const contacts = await db.query(
        "select count(*)::int as n from contacts where company = $1",
        [company]
      );
      const counters = await db.query("select name, value from counters where company = $1", [
        company
      ]);
      const inv = await db.query(
        "select id, handler, as_mode, principal, attempts, outcome, (select count(*)::int from operations o where o.invocation_id = i.id) as ops from invocations i where company = $1 order by started_at desc limit 12",
        [company]
      );
      const ops = await db.query(
        "select o.op, o.principal, o.attempt from operations o join invocations i on i.id = o.invocation_id where i.company = $1 order by o.id desc limit 12",
        [company]
      );
      return send(res, 200, {
        contacts: contacts.rows[0].n,
        counters: counters.rows,
        invocations: inv.rows,
        operations: ops.rows
      });
    }
    case "/admin/stats": {
      const t = await execFor(company);
      return send(res, 200, { task: t.id, ...(await (await fetch(`${t.url}/stats`)).json()) });
    }
    case "/admin/probe": {
      const t = await execFor(company);
      return send(res, 200, {
        task: t.id,
        supervisor: await (await fetch(`${t.url}/probe`)).json(),
        guestOutboundAttempts: await (await fetch(`${t.url}/outbound-attempts`)).json()
      });
    }
    case "/admin/coldstart": {
      // A fresh task outside the pool: RunTask -> RUNNING -> healthy -> bind -> first invoke -> stop.
      const t = await pool.startTask({ track: false });
      const name = `${company}/crm@v1`;
      const b0 = Date.now();
      const bind = await (
        await fetch(`${t.url}/bind`, {
          method: "POST",
          body: JSON.stringify({ name, bundle: bundles.v1 })
        })
      ).json();
      const bindMs = Date.now() - b0;
      const i0 = Date.now();
      await (
        await fetch(`${t.url}/invoke`, {
          method: "POST",
          body: JSON.stringify({
            name,
            invocationId: "cold",
            capability: "none",
            hostUrl,
            handler: "contacts.ping",
            args: {},
            viewer: "bench",
            budgetMs: 5000
          })
        })
      ).json();
      const invokeMs = Date.now() - i0;
      await pool.stopTask(t, "coldstart measurement");
      return send(res, 200, {
        runTaskToRunningMs: t.times.running! - t.times.runTask,
        runTaskToHealthyMs: t.times.healthy! - t.times.runTask,
        bindMs,
        bindLoadMs: bind.loadMs,
        firstInvokeMs: invokeMs,
        runTaskToFirstInvokeMs: Date.now() - t.times.runTask - 0
      });
    }
    case "/admin/sealed": {
      // One exec task under the sealed SG: what does ECS say, and how fast?
      const t0 = Date.now();
      const { ECSClient, RunTaskCommand } = await import("@aws-sdk/client-ecs");
      const ecs = new ECSClient({ region: "us-east-1" });
      const r = await ecs.send(
        new RunTaskCommand(pool.runTaskParams({ securityGroup: process.env.SPIKE_SG_EXEC_SEALED }))
      );
      const arn = r.tasks?.[0]?.taskArn;
      const events: Array<{ atMs: number; status: string; reason?: string }> = [];
      let last = "";
      for (;;) {
        await sleep(2000);
        const t = await pool.describe(arn!);
        const status = t?.lastStatus ?? "?";
        if (status !== last)
          events.push({ atMs: Date.now() - t0, status, reason: t?.stoppedReason });
        last = status;
        if (status === "STOPPED")
          return send(res, 200, {
            arn,
            events,
            stoppedReason: t?.stoppedReason,
            stopCode: t?.stopCode,
            containers: t?.containers?.map((c) => ({ reason: c.reason, exit: c.exitCode })),
            totalMs: Date.now() - t0
          });
        if (Date.now() - t0 > 600_000)
          return send(res, 200, { arn, events, gaveUpAfterMs: Date.now() - t0 });
      }
    }
    case "/admin/echo":
      return send(res, 200, { hostUrl, taskArn: process.env.TASK_ARN, startedAt });
  }
  send(res, 404, { error: "not_found" });
}

const startedAt = new Date().toISOString();
const streams = new Set<ServerResponse>();
function stream(url: URL, res: ServerResponse) {
  const doc = url.searchParams.get("doc") ?? "doc";
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  res.write(`event: open\ndata: ${JSON.stringify({ doc, host: startedAt })}\n\n`);
  let n = 0;
  const timer = setInterval(
    () => res.write(`event: tick\ndata: ${JSON.stringify({ doc, n: ++n, at: Date.now() })}\n\n`),
    1000
  );
  streams.add(res);
  res.on("close", () => {
    clearInterval(timer);
    streams.delete(res);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/healthz")
      return send(res, 200, { ok: true, startedAt, streams: streams.size });
    if (url.pathname === "/invoke") return await invoke(req, res);
    if (url.pathname === "/callback") return await callback(req, res);
    if (url.pathname === "/stream") return stream(url, res);
    if (url.pathname.startsWith("/admin/")) return await admin(url, req, res);
    send(res, 404, { error: "not_found" });
  } catch (e: any) {
    send(res, 500, { error: e.message });
  }
});

await discoverHostUrl();
await migrate();
await warm();
pool.start();
server.listen(PORT, () =>
  console.log(
    `[host] listening on ${PORT}, hostUrl ${hostUrl}, slots ${SLOTS}, deadline ${DEADLINE_MS} ms`
  )
);

// Deployment drain: finish streams cleanly when ECS sends SIGTERM.
process.on("SIGTERM", () => {
  console.log(`[host] SIGTERM with ${streams.size} streams open`);
  for (const s of streams) s.end(`event: bye\ndata: {"reason":"sigterm"}\n\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});
