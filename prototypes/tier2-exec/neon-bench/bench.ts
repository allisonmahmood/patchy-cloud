// PROTOTYPE for #311: Neon Postgres measurements from an ECS Fargate task (lane B).
// One script, plain `pg`, every measurement in sequence, Markdown to stdout.
// Env: DATABASE_URL (patchy_admin), NEON_API_KEY, NEON_PROJECT_ID, NEON_ENDPOINT_ID,
// BENCH_LABEL (local|fargate), BENCH_STEPS (comma list; default every step, restart last).
import pg from "pg";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";

process.noDeprecation = true; // pg 8 warns about Client.activeQuery, which its own cancel() uses

const { Client, Query } = pg;

const LABEL = process.env.BENCH_LABEL ?? "local";
const ALL_STEPS =
  "settings,warm,cold,mutation,contention,conflict,cancel,lostcommit,provision,idle,restart";
const STEPS = (process.env.BENCH_STEPS ?? ALL_STEPS).split(",");
const IDLE_MINUTES = Number(process.env.BENCH_IDLE_MINUTES ?? "8");
const COLD_N = Number(process.env.BENCH_COLD_N ?? "5");
const NEON = "https://console.neon.tech/api/v2";
const PROJECT = process.env.NEON_PROJECT_ID!;
const ENDPOINT = process.env.NEON_ENDPOINT_ID!;
const SCRATCH_DB = "neon_bench";

const url = new URL(process.env.DATABASE_URL!);
const HOST = url.hostname;
const USER = decodeURIComponent(url.username);
const PASSWORD = decodeURIComponent(url.password);
const ADMIN_DB = url.pathname.slice(1);

function cfg(database: string, extra: Record<string, unknown> = {}) {
  return {
    host: HOST,
    port: 5432,
    user: USER,
    password: PASSWORD,
    database,
    ssl: { rejectUnauthorized: true, servername: HOST },
    application_name: `neon-bench-${LABEL}`,
    ...extra
  };
}

// ---------- output and stats ----------
const out = (line = "") => console.log(line);
const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (n: number) => n.toFixed(1);

function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}
function statsRow(name: string, xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return `| ${name} | ${s.length} | ${ms(s[0] ?? NaN)} | ${ms(pct(s, 50))} | ${ms(pct(s, 95))} | ${ms(pct(s, 99))} | ${ms(s[s.length - 1] ?? NaN)} | ${ms(mean)} |`;
}
const STATS_HEADER =
  "| measure | n | min | p50 | p95 | p99 | max | mean |\n|---|---|---|---|---|---|---|---|";

// ---------- Neon API ----------
async function neon(method: string, path: string) {
  const res = await fetch(`${NEON}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.NEON_API_KEY}`, Accept: "application/json" }
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`neon ${method} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}
async function endpointState(): Promise<string> {
  const b = await neon("GET", `/projects/${PROJECT}/endpoints/${ENDPOINT}`);
  return `${b.endpoint.current_state}${b.endpoint.pending_state ? `->${b.endpoint.pending_state}` : ""}`;
}
async function waitOps(ops: any[]) {
  for (const op of ops ?? []) {
    for (;;) {
      const b = await neon("GET", `/projects/${PROJECT}/operations/${op.id}`);
      const s = b.operation.status;
      if (s === "finished") break;
      if (s === "failed" || s === "error" || s === "cancelled" || s === "skipped")
        throw new Error(`operation ${op.action} ${s}`);
      await sleep(500);
    }
  }
}
async function endpointAction(action: "suspend" | "restart") {
  const t0 = now();
  const b = await neon("POST", `/projects/${PROJECT}/endpoints/${ENDPOINT}/${action}`);
  const apiMs = now() - t0;
  await waitOps(b.operations);
  return {
    apiMs,
    opsMs: now() - t0,
    actions: (b.operations ?? []).map((o: any) => o.action).join("+")
  };
}

// ---------- connection helpers ----------
async function connect(database: string, extra: Record<string, unknown> = {}) {
  const c = new Client(cfg(database, extra));
  c.on("error", () => {}); // a killed socket rejects the pending query; do not crash the process
  const t0 = now();
  await c.connect();
  return { c, connectMs: now() - t0 };
}
async function timed(c: pg.Client, text: string, values?: unknown[]) {
  const t0 = now();
  const r = await c.query(text, values);
  return { r, ms: now() - t0 };
}
async function dnsMs() {
  const t0 = now();
  const a = await dns.lookup(HOST);
  return { ms: now() - t0, address: a.address };
}
// TCP connect, then Postgres SSLRequest, then a TLS handshake against the Neon proxy; no auth.
function rawHandshake(): Promise<{ tcpMs: number; sslReqMs: number; tlsMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = now();
    let tcpMs = 0;
    let sslReqMs = 0;
    const sock = net.connect(5432, HOST, () => {
      tcpMs = now() - t0;
      const t1 = now();
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      sock.write(req);
      sock.once("data", (b) => {
        sslReqMs = now() - t1;
        if (b.toString() !== "S") return reject(new Error(`SSLRequest answered ${b.toString()}`));
        const t2 = now();
        const s = tls.connect({ socket: sock, servername: HOST, rejectUnauthorized: true }, () => {
          const tlsMs = now() - t2;
          s.destroy();
          resolve({ tcpMs, sslReqMs, tlsMs });
        });
        s.on("error", reject);
      });
    });
    sock.on("error", reject);
  });
}

// Reclaim a company role and its database the way SET-only membership allows: act as the owner to drop the database.
async function dropCompany(admin: pg.Client, name: string) {
  await admin.query(`grant ${name} to ${USER} with set true`).catch(() => {});
  await admin.query(`set role ${name}`).catch(() => {});
  await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
  await admin.query("reset role").catch(() => {});
  await admin.query(`drop role if exists ${name}`).catch(() => {});
}

// ---------- steps ----------
async function stepSettings(admin: pg.Client) {
  out(`## Server settings (${LABEL})`);
  const v = await admin.query("select version() v, current_user u, current_database() d");
  out(`- version: \`${v.rows[0].v}\``);
  out(`- connected as \`${v.rows[0].u}\` to \`${v.rows[0].d}\``);
  const wanted = [
    "max_connections",
    "superuser_reserved_connections",
    "statement_timeout",
    "lock_timeout",
    "idle_in_transaction_session_timeout",
    "idle_session_timeout",
    "default_transaction_isolation",
    "max_prepared_transactions",
    "createrole_self_grant",
    "shared_buffers",
    "work_mem",
    "wal_level",
    "max_locks_per_transaction",
    "max_pred_locks_per_transaction",
    "ssl",
    "server_version"
  ];
  const s = await admin.query(
    "select name, setting, unit from pg_settings where name = any($1) order by name",
    [wanted]
  );
  out("");
  out("| setting | value |\n|---|---|");
  for (const r of s.rows) out(`| ${r.name} | ${r.setting}${r.unit ? " " + r.unit : ""} |`);
  const n = await admin.query(
    "select name, setting from pg_settings where name like 'neon.%' order by name"
  );
  const interesting = [
    "neon.compute_mode",
    "neon.endpoint_id",
    "neon.privileged_role_name",
    "neon.max_cluster_size",
    "neon.file_cache_size_limit",
    "neon.forward_ddl",
    "neon.event_triggers",
    "neon.protocol_version",
    "neon.safekeeper_proto_version",
    "neon.communicator_mode",
    "neon.lakebase_mode",
    "neon.max_reconnect_attempts"
  ];
  out("");
  out(`\`neon.*\` settings visible: ${n.rows.length}. A selection:`);
  out("");
  out("| setting | value |\n|---|---|");
  for (const r of n.rows) if (interesting.includes(r.name)) out(`| ${r.name} | ${r.setting} |`);
  const roles = await admin.query(
    "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin from pg_roles where rolname not like 'pg_%' order by 1"
  );
  out("");
  out("| role | super | createdb | createrole | login |\n|---|---|---|---|---|");
  for (const r of roles.rows)
    out(
      `| ${r.rolname} | ${r.rolsuper} | ${r.rolcreatedb} | ${r.rolcreaterole} | ${r.rolcanlogin} |`
    );
  const act = await admin.query(
    "select usename, application_name, state, count(*)::int n from pg_stat_activity where backend_type='client backend' group by 1,2,3 order by 1,2,3"
  );
  out("");
  out("Client backends at start (other lanes share this compute):");
  out("");
  out("| user | application | state | n |\n|---|---|---|---|");
  for (const r of act.rows) out(`| ${r.usename} | ${r.application_name} | ${r.state} | ${r.n} |`);
  out("");
}

async function setupScratch(admin: pg.Client) {
  await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
  const t0 = now();
  await admin.query(`create database ${SCRATCH_DB}`);
  out(`- \`CREATE DATABASE ${SCRATCH_DB}\`: ${ms(now() - t0)} ms`);
  const { c } = await connect(SCRATCH_DB);
  await c.query(`
    create table items (id bigserial primary key, name text not null, qty int not null default 0);
    create table counter (id int primary key, n bigint not null default 0);
    insert into counter (id, n) values (1,0),(2,0),(3,0),(4,0);
    insert into items (name, qty) select 'seed-' || g, g from generate_series(1, 200) g;
  `);
  await c.end();
}

async function stepWarm() {
  const N = 50;
  out(`## 1a. Round trip, warm compute (${LABEL}, n=${N})`);
  out("");
  out(`Endpoint state before: \`${await endpointState()}\`.`);
  const dnsT: number[] = [],
    tcp: number[] = [],
    sslReq: number[] = [],
    tlsT: number[] = [];
  const conn: number[] = [],
    auth: number[] = [],
    q1: number[] = [],
    q2: number[] = [],
    total: number[] = [];
  let address = "";
  for (let i = 0; i < N; i++) {
    const t0 = now();
    const d = await dnsMs();
    address = d.address;
    const h = await rawHandshake();
    const { c, connectMs } = await connect(SCRATCH_DB);
    const a = await timed(c, "select 1");
    const b = await timed(c, "select 1");
    await c.end();
    dnsT.push(d.ms);
    tcp.push(h.tcpMs);
    sslReq.push(h.sslReqMs);
    tlsT.push(h.tlsMs);
    conn.push(connectMs);
    auth.push(connectMs - d.ms - h.tcpMs - h.sslReqMs - h.tlsMs);
    q1.push(a.ms);
    q2.push(b.ms);
    total.push(now() - t0);
  }
  out(
    `Resolved \`${HOST}\` to \`${address}\`. Each iteration: a DNS lookup, a raw TCP+SSLRequest+TLS handshake (no auth, closed), then a fresh \`pg\` \`connect()\` (its own DNS+TCP+TLS+SASL auth), \`SELECT 1\` twice, \`end()\`. "auth (derived)" is pg connect minus the separately measured DNS+TCP+SSLRequest+TLS, so it also absorbs any variance between the two handshakes.`
  );
  out("");
  out(STATS_HEADER);
  out(statsRow("DNS lookup", dnsT));
  out(statsRow("TCP connect (raw)", tcp));
  out(statsRow("SSLRequest round trip (raw)", sslReq));
  out(statsRow("TLS handshake (raw)", tlsT));
  out(statsRow("pg connect() total (DNS+TCP+TLS+auth)", conn));
  out(statsRow("auth (derived)", auth));
  out(statsRow("first SELECT 1", q1));
  out(statsRow("second SELECT 1", q2));
  out(statsRow("iteration total", total));
  out("");
}

async function stepCold() {
  const N = COLD_N;
  out(`## 1b. Round trip, cold compute (${LABEL}, n=${N} suspend cycles)`);
  out("");
  out(
    "Each cycle: `POST .../suspend` and wait for its operation, wait 3 s, read the endpoint state, then a DNS lookup, a raw TCP+TLS handshake to the proxy (no auth), a fresh `pg` `connect()` (this is where the proxy wakes the compute), `SELECT 1`, `end()`. If the state before connecting is not `idle`, something else (the other lane's pool) woke the compute first and the cycle is not cold."
  );
  out("");
  out(
    "| cycle | suspend API | suspend op done | state before connect | DNS | raw TCP | raw TLS | pg connect() (includes wake) | first SELECT 1 | second SELECT 1 | state after |\n|---|---|---|---|---|---|---|---|---|---|---|"
  );
  const conn: number[] = [],
    q1: number[] = [];
  for (let i = 1; i <= N; i++) {
    const s = await endpointAction("suspend");
    await sleep(3000);
    const before = await endpointState();
    const d = await dnsMs();
    const h = await rawHandshake();
    const { c, connectMs } = await connect(SCRATCH_DB);
    const a = await timed(c, "select 1");
    const b = await timed(c, "select 1");
    await c.end();
    const after = await endpointState();
    conn.push(connectMs);
    q1.push(a.ms);
    out(
      `| ${i} | ${ms(s.apiMs)} | ${ms(s.opsMs)} | ${before} | ${ms(d.ms)} | ${ms(h.tcpMs)} | ${ms(h.tlsMs)} | ${ms(connectMs)} | ${ms(a.ms)} | ${ms(b.ms)} | ${after} |`
    );
  }
  out("");
  out(STATS_HEADER);
  out(statsRow("cold pg connect() (wake + auth)", conn));
  out(statsRow("cold first SELECT 1", q1));
  out("");
}

// The ten statements a tier 2 mutation issues through callbacks, inside one SERIALIZABLE transaction.
async function tenCallbackMutation(c: pg.Client, tag: string) {
  const per: number[] = [];
  const run = async (text: string, values?: unknown[]) => {
    const { r, ms } = await timed(c, text, values);
    per.push(ms);
    return r;
  };
  const t0 = now();
  await run("begin isolation level serializable");
  await run("select id, name, qty from items order by id limit 20"); // tables.list
  const ins = await run("insert into items (name, qty) values ($1, 1) returning id", [`${tag}-a`]); // tables.insert
  const idA = ins.rows[0].id;
  await run("select id, name, qty from items where id = $1", [idA]); // read own write
  await run("update items set qty = qty + 1 where id = $1 returning qty", [idA]); // tables.update
  await run("select qty from items where id = $1", [idA]); // read own write again
  const ins2 = await run("insert into items (name, qty) values ($1, 2) returning id", [`${tag}-b`]);
  const idB = ins2.rows[0].id;
  await run("update items set qty = qty + 10 where id in ($1, $2)", [idA, idB]);
  await run("select count(*)::int n from items where name like $1", [`${tag}-%`]);
  await run("update counter set n = n + 1 where id = 1 returning n");
  await run("select n from counter where id = 1");
  await run("commit");
  return { totalMs: now() - t0, per };
}

async function stepMutation() {
  const N = 100;
  out(`## 2a. Ten-callback SERIALIZABLE mutation, warm, one reused connection (${LABEL}, n=${N})`);
  out("");
  const { c, connectMs } = await connect(SCRATCH_DB);
  out(
    `Connection opened in ${ms(connectMs)} ms and reused (a pooled host connection). Each mutation is \`BEGIN ISOLATION LEVEL SERIALIZABLE\`, ten statements (list, insert, read-own-write, update, read-own-write, insert, update, count, counter update, counter read), \`COMMIT\`: 12 round trips.`
  );
  await tenCallbackMutation(c, "warmup");
  const totals: number[] = [];
  const perPos: number[][] = Array.from({ length: 12 }, () => []);
  const all: number[] = [];
  for (let i = 0; i < N; i++) {
    const m = await tenCallbackMutation(c, `m${i}`);
    totals.push(m.totalMs);
    m.per.forEach((x, j) => {
      perPos[j]!.push(x);
      all.push(x);
    });
  }
  await c.end();
  out("");
  out(STATS_HEADER);
  out(statsRow("mutation total (12 round trips)", totals));
  out(statsRow("per-statement round trip (all 12 positions)", all));
  const names = [
    "BEGIN SERIALIZABLE",
    "SELECT list (20 rows)",
    "INSERT RETURNING",
    "SELECT own write",
    "UPDATE RETURNING",
    "SELECT own write",
    "INSERT RETURNING",
    "UPDATE two rows",
    "SELECT count",
    "UPDATE counter",
    "SELECT counter",
    "COMMIT"
  ];
  names.forEach((n, j) => out(statsRow(`  ${j + 1}. ${n}`, perPos[j]!)));
  out("");
}

async function contention(slots: number, seconds: number, counterId: number) {
  const workers = await Promise.all(Array.from({ length: slots }, () => connect(SCRATCH_DB)));
  const start = (await workers[0]!.c.query("select n from counter where id = $1", [counterId]))
    .rows[0].n;
  const deadline = now() + seconds * 1000;
  const result = {
    commits: 0,
    conflicts: 0,
    otherErrors: [] as string[],
    latencies: [] as number[],
    attempts: 0,
    conflictAt: { select: 0, update: 0, commit: 0 }
  };
  await Promise.all(
    workers.map(async ({ c }) => {
      while (now() < deadline) {
        const t0 = now();
        result.attempts++;
        let stage = "select";
        try {
          await c.query("begin isolation level serializable");
          const n = (await c.query("select n from counter where id = $1", [counterId])).rows[0].n;
          stage = "update";
          await c.query("update counter set n = $2 where id = $1", [counterId, Number(n) + 1]);
          stage = "commit";
          await c.query("commit");
          result.commits++;
          result.latencies.push(now() - t0);
        } catch (e: any) {
          await c.query("rollback").catch(() => {});
          if (e.code === "40001") {
            result.conflicts++;
            (result.conflictAt as any)[stage]++;
          } else result.otherErrors.push(`${e.code}: ${e.message}`);
        }
      }
    })
  );
  const end = (await workers[0]!.c.query("select n from counter where id = $1", [counterId]))
    .rows[0].n;
  await Promise.all(workers.map((w) => w.c.end()));
  return { ...result, start: Number(start), end: Number(end), seconds };
}

async function stepContention() {
  out(
    `## 2b. Contention on one counter row, SERIALIZABLE read-then-write, retry on 40001 (${LABEL})`
  );
  out("");
  out(
    "Each slot loops `BEGIN SERIALIZABLE; SELECT n; UPDATE n = read+1; COMMIT` on its own connection for 30 s; a `40001` rolls back and retries. Correct means the final counter equals start + commits."
  );
  out("");
  out(
    "| slots | seconds | attempts | commits | 40001s | 40001 at UPDATE | 40001 at COMMIT | other errors | commits/s | commit p50 | commit p95 | commit p99 | counter start -> end | correct |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const slots of [4, 2]) {
    const r = await contention(slots, 30, 2);
    const s = [...r.latencies].sort((a, b) => a - b);
    out(
      `| ${slots} | ${r.seconds} | ${r.attempts} | ${r.commits} | ${r.conflicts} | ${r.conflictAt.update} | ${r.conflictAt.commit} | ${r.otherErrors.length} | ${(r.commits / r.seconds).toFixed(1)} | ${ms(pct(s, 50))} | ${ms(pct(s, 95))} | ${ms(pct(s, 99))} | ${r.start} -> ${r.end} | ${r.end === r.start + r.commits} |`
    );
    if (r.otherErrors.length)
      out(`  other errors (${slots} slots): ${[...new Set(r.otherErrors)].join("; ")}`);
  }
  out("");
}

async function stepConflict() {
  out(
    `## 2c. Confirmed 40001, deterministic: two transactions read then write the same row (${LABEL})`
  );
  out("");
  const A = (await connect(SCRATCH_DB)).c;
  const B = (await connect(SCRATCH_DB)).c;
  const start = Number((await A.query("select n from counter where id = 3")).rows[0].n);
  await A.query("begin isolation level serializable");
  const nA = Number((await A.query("select n from counter where id = 3")).rows[0].n);
  await B.query("begin isolation level serializable");
  const nB = Number((await B.query("select n from counter where id = 3")).rows[0].n);
  await A.query("update counter set n = $1 where id = 3", [nA + 1]);
  await A.query("commit");
  let where = "UPDATE";
  let err: any;
  try {
    await B.query("update counter set n = $1 where id = 3", [nB + 1]);
    where = "COMMIT";
    await B.query("commit");
  } catch (e) {
    err = e;
  }
  await B.query("rollback").catch(() => {});
  out(`- A read ${nA}, B read ${nB}; A wrote ${nA + 1} and committed.`);
  out(
    `- B's ${where} failed: SQLSTATE \`${err?.code}\`, \`${err?.message}\`${err?.detail ? ` (detail: ${err.detail})` : ""}${err?.hint ? ` (hint: ${err.hint})` : ""}.`
  );
  // retry B whole
  await B.query("begin isolation level serializable");
  const nB2 = Number((await B.query("select n from counter where id = 3")).rows[0].n);
  await B.query("update counter set n = $1 where id = 3", [nB2 + 1]);
  await B.query("commit");
  const end = Number((await A.query("select n from counter where id = 3")).rows[0].n);
  out(
    `- B retried from the top: read ${nB2}, wrote ${nB2 + 1}, committed. Counter ${start} -> ${end}; correct: ${end === start + 2}.`
  );
  await A.end();
  await B.end();
  out("");
}

async function pgStatFor(pid: number) {
  const { c } = await connect(SCRATCH_DB);
  const r = await c.query(
    "select state, wait_event_type, backend_xid is not null as has_xid from pg_stat_activity where pid = $1",
    [pid]
  );
  await c.end();
  return r.rows[0] ? `state=\`${r.rows[0].state}\`` : "gone (no pg_stat_activity row)";
}

// A raw CancelRequest over TLS: TCP, SSLRequest, TLS, then the cancel packet. libpq 17 does this; pg 8 sends it in plaintext.
function rawCancelOverTls(pid: number, key: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const sock = net.connect(5432, HOST, () => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      sock.write(req);
      sock.once("data", (b) => {
        if (b.toString() !== "S") return reject(new Error(`SSLRequest answered ${b.toString()}`));
        const s = tls.connect({ socket: sock, servername: HOST, rejectUnauthorized: true }, () => {
          const cancel = Buffer.alloc(16);
          cancel.writeInt32BE(16, 0);
          cancel.writeInt32BE(80877102, 4);
          cancel.writeInt32BE(pid, 8);
          cancel.writeInt32BE(key, 12);
          s.write(cancel);
          s.on("close", () => resolve(now() - t0));
          s.on("end", () => s.destroy());
        });
        s.on("error", reject);
      });
    });
    sock.on("error", reject);
  });
}

async function stepCancel() {
  out(
    `## 2d. Cancellation: client-side CancelRequest and the five-second statement_timeout race (${LABEL})`
  );
  out("");
  // (i) pg's cancel path alone against pg_sleep(10), no server timeout.
  {
    const { c } = await connect(SCRATCH_DB);
    const fakePid = (c as any).processID as number;
    const key = (c as any).secretKey as number;
    const pid = Number((await c.query("select pg_backend_pid() p")).rows[0].p);
    out(
      `- BackendKeyData from the proxy: process id ${fakePid}, secret key ${key === 0 ? "0" : "nonzero"}; the real backend pid is ${pid}, so the proxy hands out its own cancel key and maps it.`
    );
    await c.query("begin");
    const q = new Query("select pg_sleep(10)");
    const t0 = now();
    const done = new Promise<any>((resolve) => {
      q.on("error", resolve);
      q.on("end", () => resolve(null));
    });
    c.query(q);
    await sleep(1000);
    const tc = now();
    new Client(cfg(SCRATCH_DB)).cancel(c, q); // plaintext CancelRequest on a new TCP connection, pg 8's path
    const err = await Promise.race([
      done,
      sleep(12000).then(() => ({
        code: "timeout",
        message: "pg_sleep(10) finished or nothing answered in 12 s"
      }))
    ]);
    const elapsed = now() - t0;
    out(
      `- (i) pg's plaintext \`CancelRequest\` sent at 1.0 s into \`pg_sleep(10)\` inside \`BEGIN\`: statement ended after ${ms(elapsed)} ms (${ms(now() - tc)} ms after the cancel), SQLSTATE \`${err?.code}\`, \`${err?.message}\`.`
    );
    out(
      `  - after the error: ${await pgStatFor(pid)} from a second connection; transaction status on the client: \`${(c as any).getTransactionStatus?.() ?? "n/a"}\`.`
    );
    await c.query("rollback").catch(() => {});
    await c.end();
    await sleep(300);
    out(`  - after \`ROLLBACK\` + \`end()\`: ${await pgStatFor(pid)}.`);
    if (err?.code !== "57014") {
      // fallback: CancelRequest over TLS
      const { c: c2 } = await connect(SCRATCH_DB);
      const pid2 = (c2 as any).processID as number,
        key2 = (c2 as any).secretKey as number; // the proxy's key pair, as libpq would send
      await c2.query("begin");
      const q2 = new Query("select pg_sleep(10)");
      const t1 = now();
      const done2 = new Promise<any>((resolve) => {
        q2.on("error", resolve);
        q2.on("end", () => resolve(null));
      });
      c2.query(q2);
      await sleep(1000);
      let cancelMs = NaN;
      try {
        cancelMs = await rawCancelOverTls(pid2, key2);
      } catch (e: any) {
        out(`  - raw TLS CancelRequest failed: ${e.message}`);
      }
      const err2 = await Promise.race([
        done2,
        sleep(12000).then(() => ({ code: "timeout", message: "nothing answered in 12 s" }))
      ]);
      out(
        `- (i-b) \`CancelRequest\` over TLS (TCP, SSLRequest, TLS, cancel packet; ${ms(cancelMs)} ms until the proxy closed it): statement ended after ${ms(now() - t1)} ms, SQLSTATE \`${err2?.code}\`, \`${err2?.message}\`.`
      );
      await c2.query("rollback").catch(() => {});
      await c2.end();
    }
  }
  // (ii) the race: SET LOCAL statement_timeout = 5000 and a client timer at 5000 ms.
  {
    const { c } = await connect(SCRATCH_DB);
    const pid = Number((await c.query("select pg_backend_pid() p")).rows[0].p);
    await c.query("begin isolation level serializable");
    await c.query("set local statement_timeout = '5000'");
    await c.query("insert into items (name, qty) values ('cancel-race', 0)");
    const q = new Query("select pg_sleep(10)");
    const t0 = now();
    const done = new Promise<any>((resolve) => {
      q.on("error", resolve);
      q.on("end", () => resolve(null));
    });
    c.query(q);
    let cancelSentAt = NaN;
    const timer = setTimeout(() => {
      cancelSentAt = now() - t0;
      new Client(cfg(SCRATCH_DB)).cancel(c, q);
    }, 5000);
    const err = await Promise.race([
      done,
      sleep(12000).then(() => ({ code: "timeout", message: "nothing answered in 12 s" }))
    ]);
    clearTimeout(timer);
    const elapsed = now() - t0;
    const first = err?.message?.includes("statement timeout")
      ? "server statement_timeout"
      : err?.message?.includes("user request")
        ? "client CancelRequest"
        : "unclear";
    out(
      `- (ii) \`SET LOCAL statement_timeout = '5000'\` and a client timer at 5000 ms around \`pg_sleep(10)\` in a SERIALIZABLE transaction with one insert: fired first: **${first}**; statement ended after ${ms(elapsed)} ms (client cancel sent at ${Number.isNaN(cancelSentAt) ? "never" : ms(cancelSentAt) + " ms"}), SQLSTATE \`${err?.code}\`, \`${err?.message}\`.`
    );
    out(
      `  - after the error: ${await pgStatFor(pid)}; client transaction status \`${(c as any).getTransactionStatus?.() ?? "n/a"}\`.`
    );
    let commitErr: any;
    try {
      await c.query("commit");
    } catch (e) {
      commitErr = e;
    }
    out(
      `  - \`COMMIT\` on the aborted transaction: ${commitErr ? `SQLSTATE \`${commitErr.code}\`, \`${commitErr.message}\`` : "accepted (Postgres turns it into ROLLBACK, command tag would say so)"}.`
    );
    await c.end();
    await sleep(300);
    const { c: c2 } = await connect(SCRATCH_DB);
    const landed = (await c2.query("select count(*)::int n from items where name = 'cancel-race'"))
      .rows[0].n;
    await c2.end();
    out(
      `  - after \`end()\`: ${await pgStatFor(pid)}; rows named \`cancel-race\` in the table: ${landed} (transaction gone, nothing landed).`
    );
  }
  out("");
}

// A tiny TCP proxy between pg and Neon so the COMMIT reaches the server and its reply is dropped.
function startDropProxy(): Promise<{ port: number; dropNextReply: () => void; close: () => void }> {
  const state = { drop: false };
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(5432, HOST);
      let blackhole = false;
      client.on("data", (d) => {
        upstream.write(d);
        if (state.drop) {
          state.drop = false;
          blackhole = true;
          setTimeout(() => client.destroy(), 300);
        }
      });
      upstream.on("data", (d) => {
        if (!blackhole) client.write(d);
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        if (!blackhole) client.destroy();
      });
      client.on("error", () => {});
      upstream.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        dropNextReply: () => {
          state.drop = true;
        },
        close: () => server.close()
      })
    );
  });
}

async function stepLostCommit() {
  out(`## 2e. Lost commit reply (${LABEL})`);
  out("");
  // (a) through a proxy that forwards COMMIT and drops the reply.
  {
    const proxy = await startDropProxy();
    const c = new Client({ ...cfg(SCRATCH_DB), host: "127.0.0.1", port: proxy.port });
    c.on("error", () => {});
    await c.connect();
    const tag = `lost-proxy-${randomUUID().slice(0, 8)}`;
    await c.query("begin isolation level serializable");
    await c.query("insert into items (name, qty) values ($1, 1)", [tag]);
    proxy.dropNextReply();
    let err: any;
    const t0 = now();
    try {
      await c.query("commit");
    } catch (e) {
      err = e;
    }
    const elapsed = now() - t0;
    c.end().catch(() => {});
    proxy.close();
    const { c: c2 } = await connect(SCRATCH_DB);
    const landed = (await c2.query("select count(*)::int n from items where name = $1", [tag]))
      .rows[0].n;
    await c2.end();
    out(
      `- (a) via a local TCP proxy that forwards \`COMMIT\` and drops the reply, then destroys the socket: client saw after ${ms(elapsed)} ms: ${err ? `\`${err.code ?? err.name}\`: \`${err.message}\`` : "no error (!)"}; from a second connection the row is ${landed === 1 ? "**present** (the commit landed)" : "absent"}. The client could not tell: \`unknown_outcome\`.`
    );
  }
  // (b) write COMMIT then socket.destroy() in the same tick on a direct TLS connection.
  {
    const { c } = await connect(SCRATCH_DB);
    const tag = `lost-destroy-${randomUUID().slice(0, 8)}`;
    await c.query("begin isolation level serializable");
    await c.query("insert into items (name, qty) values ($1, 1)", [tag]);
    let err: any;
    const t0 = now();
    const p = c.query("commit").catch((e) => {
      err = e;
    });
    (c as any).connection.stream.destroy();
    await p;
    const elapsed = now() - t0;
    await sleep(500);
    const { c: c2 } = await connect(SCRATCH_DB);
    const landed = (await c2.query("select count(*)::int n from items where name = $1", [tag]))
      .rows[0].n;
    await c2.end();
    out(
      `- (b) \`query("COMMIT")\` then \`stream.destroy()\` in the same tick on the direct TLS socket: client saw after ${ms(elapsed)} ms: ${err ? `\`${err.code ?? err.name}\`: \`${err.message}\`` : "no error"}; row ${landed === 1 ? "**present** (COMMIT left the TLS buffer before destroy)" : "**absent** (destroy discarded the buffered COMMIT; the server rolled back on disconnect)"}. Same client-side signal either way.`
    );
  }
  out("");
}

async function stepProvision() {
  out(`## 4. ADR-0009 provisioning path under neon_superuser (${LABEL})`);
  out("");
  const admin = (await connect(ADMIN_DB)).c; // fresh: an earlier suspend cycle kills long-lived connections
  out("| step | statement | result | ms |\n|---|---|---|---|");
  const row = async (label: string, sql: string, run: () => Promise<string>) => {
    const t0 = now();
    let res: string;
    try {
      res = await run();
    } catch (e: any) {
      res = `**refused**: SQLSTATE \`${e.code}\`, ${e.message}`;
    }
    out(`| ${label} | \`${sql}\` | ${res} | ${ms(now() - t0)} |`);
  };
  const pw = randomUUID();
  await dropCompany(admin, "company_x");
  await dropCompany(admin, "company_y");
  await row("create login role", "CREATE ROLE company_x LOGIN PASSWORD '...'", async () => {
    await admin.query(`create role company_x login password '${pw}'`);
    return "ok";
  });
  await row(
    "membership granted to creator",
    "SELECT ... FROM pg_auth_members WHERE roleid = 'company_x'",
    async () => {
      const r = await admin.query(
        "select member::regrole m, admin_option a, set_option s, inherit_option i from pg_auth_members where roleid = 'company_x'::regrole"
      );
      return r.rows.length
        ? r.rows.map((x) => `${x.m}: admin=${x.a} set=${x.s} inherit=${x.i}`).join("; ")
        : "none";
    }
  );
  await row(
    "create database owned (first try)",
    "CREATE DATABASE company_x OWNER company_x",
    async () => {
      await admin.query("create database company_x owner company_x");
      return "ok";
    }
  );
  await row(
    "grant SET to the creator",
    "GRANT company_x TO patchy_admin WITH SET TRUE",
    async () => {
      await admin.query("grant company_x to patchy_admin with set true");
      return "ok";
    }
  );
  await row(
    "membership after the grant (INHERIT defaults to the grantee's attribute)",
    "SELECT ... FROM pg_auth_members WHERE roleid = 'company_x'",
    async () => {
      const r = await admin.query(
        "select member::regrole m, admin_option a, set_option s, inherit_option i from pg_auth_members where roleid = 'company_x'::regrole"
      );
      return r.rows.map((x) => `${x.m}: admin=${x.a} set=${x.s} inherit=${x.i}`).join("; ");
    }
  );
  await row(
    "create database owned (after the grant)",
    "CREATE DATABASE company_x OWNER company_x",
    async () => {
      await admin.query("create database company_x owner company_x");
      return "ok";
    }
  );
  await row(
    "verify owner",
    "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'company_x'",
    async () =>
      (
        await admin.query(
          "select pg_get_userbyid(datdba) o from pg_database where datname = 'company_x'"
        )
      ).rows[0]?.o ?? "no such database"
  );
  let cx: pg.Client | undefined;
  await row(
    "admin connects to company_x",
    "connect(database=company_x) as patchy_admin",
    async () => {
      cx = (await connect("company_x")).c;
      return "ok";
    }
  );
  const on = (f: (c: pg.Client) => Promise<string>) => async () =>
    cx ? f(cx) : "skipped (no connection)";
  await row(
    "set role",
    "SET ROLE company_x",
    on(async (c) => {
      await c.query("set role company_x");
      return (await c.query("select current_user u, session_user s")).rows.map(
        (r) => `current_user=${r.u} session_user=${r.s}`
      )[0];
    })
  );
  await row(
    "create table as company_x",
    "CREATE TABLE t (id int)",
    on(async (c) => {
      await c.query("create table t (id int primary key)");
      return `owner ${(await c.query("select tableowner from pg_tables where tablename = 't'")).rows[0].tableowner}`;
    })
  );
  await row(
    "create schema as company_x",
    "CREATE SCHEMA patchy",
    on(async (c) => {
      await c.query("create schema patchy");
      return `owner ${(await c.query("select schema_owner from information_schema.schemata where schema_name = 'patchy'")).rows[0].schema_owner}`;
    })
  );
  await row(
    "reset role",
    "RESET ROLE",
    on(async (c) => {
      await c.query("reset role");
      return (await c.query("select current_user u")).rows[0].u;
    })
  );
  await row(
    "admin reads the table without INHERIT",
    "SELECT count(*) FROM t (as patchy_admin)",
    on(async (c) => String((await c.query("select count(*)::int n from t")).rows[0].n))
  );
  await cx?.end();
  await row("company_x logs in", "connect(user=company_x, database=company_x)", async () => {
    const c = new Client({ ...cfg("company_x"), user: "company_x", password: pw });
    await c.connect();
    const r = await c.query("insert into t values (1) returning id");
    await c.end();
    return `ok, inserted id ${r.rows[0].id}`;
  });
  await row("revoke membership", "REVOKE company_x FROM patchy_admin", async () => {
    await admin.query("revoke company_x from patchy_admin");
    return "ok";
  });
  await row("set role after revoke", "SET ROLE company_x (expected to fail)", async () => {
    const c = (await connect("company_x")).c;
    try {
      await c.query("set role company_x");
      return "allowed (!)";
    } finally {
      await c.end();
    }
  });
  await row(
    "drop database without membership",
    "DROP DATABASE company_x (as patchy_admin, CREATEDB, not a member)",
    async () => {
      await admin.query("drop database company_x");
      return "ok";
    }
  );
  await row(
    "re-grant SET only (creator holds ADMIN OPTION)",
    "GRANT company_x TO patchy_admin WITH SET TRUE, INHERIT FALSE",
    async () => {
      await admin.query("grant company_x to patchy_admin with set true, inherit false");
      return "ok";
    }
  );
  await row(
    "drop database with SET only",
    "DROP DATABASE company_x (member with SET, no INHERIT; expected 42501)",
    async () => {
      await admin.query("drop database company_x");
      return "ok";
    }
  );
  await row(
    "drop database as the owner",
    "SET ROLE company_x; DROP DATABASE company_x; RESET ROLE",
    async () => {
      await admin.query("set role company_x");
      try {
        await admin.query("drop database company_x");
      } finally {
        await admin.query("reset role");
      }
      return "ok";
    }
  );
  await row("drop role", "DROP ROLE company_x", async () => {
    await admin.query("drop role company_x");
    return "ok";
  });
  await row(
    "nologin variant with self-grant",
    "SET createrole_self_grant = 'set'; CREATE ROLE company_y NOLOGIN; CREATE DATABASE company_y OWNER company_y; SET ROLE company_y; DROP DATABASE; RESET ROLE; DROP ROLE",
    async () => {
      await admin.query("set createrole_self_grant = 'set'");
      await admin.query("create role company_y nologin");
      const m = (
        await admin.query(
          "select member::regrole m, admin_option a, set_option s, inherit_option i from pg_auth_members where roleid = 'company_y'::regrole"
        )
      ).rows
        .map((x) => `${x.m}: admin=${x.a} set=${x.s} inherit=${x.i}`)
        .join("; ");
      await admin.query("create database company_y owner company_y");
      const o = (
        await admin.query(
          "select pg_get_userbyid(datdba) o from pg_database where datname = 'company_y'"
        )
      ).rows[0].o;
      await admin.query("set role company_y");
      await admin.query("drop database company_y");
      await admin.query("reset role");
      await admin.query("drop role company_y");
      await admin.query("reset createrole_self_grant");
      return `membership ${m}; owner ${o}; dropped`;
    }
  );
  await row(
    "create database inside a transaction",
    "BEGIN; CREATE DATABASE company_z (expected 25001)",
    async () => {
      await admin.query("begin");
      try {
        await admin.query("create database company_z");
        return "allowed (!)";
      } finally {
        await admin.query("rollback");
      }
    }
  );
  out("");
}

async function stepIdle() {
  out(`## Idle connection vs autosuspend (${LABEL}, up to ${IDLE_MINUTES} min)`);
  out("");
  const { c: probe } = await connect(SCRATCH_DB);
  const others = await probe.query(
    "select usename, application_name, state, count(*)::int n from pg_stat_activity where backend_type='client backend' and pid <> pg_backend_pid() group by 1,2,3 order by 1,2,3"
  );
  await probe.end();
  out(
    `Other client backends when the idle connection opened: ${others.rows.length ? others.rows.map((r) => `${r.usename}/${r.application_name}/${r.state} x${r.n}`).join(", ") : "none"}. If another lane holds connections, they could either keep the compute awake or be dropped by the suspend along with ours.`
  );
  out("");
  const { c } = await connect(SCRATCH_DB);
  await c.query("select 1");
  const t0 = now();
  let closed = false;
  c.on("error", () => {
    closed = true;
  });
  c.on("end", () => {
    closed = true;
  });
  out("| minute | endpoint state | idle socket |\n|---|---|---|");
  let suspendedAt = NaN;
  for (let m = 0; m <= IDLE_MINUTES * 2; m++) {
    const st = await endpointState();
    out(`| ${(m / 2).toFixed(1)} | ${st} | ${closed ? "closed by server" : "open"} |`);
    if (st.startsWith("idle") && Number.isNaN(suspendedAt)) suspendedAt = now() - t0;
    if (!Number.isNaN(suspendedAt) && closed) break;
    if (!Number.isNaN(suspendedAt) && m > 0 && now() - t0 - suspendedAt > 30000) break;
    await sleep(30000);
  }
  let probeErr: any;
  try {
    await c.query("select 1");
  } catch (e) {
    probeErr = e;
  }
  out("");
  out(
    `- Compute ${Number.isNaN(suspendedAt) ? `did **not** suspend within ${IDLE_MINUTES} min while one idle (not in transaction) connection stayed open` : `suspended after ${(suspendedAt / 60000).toFixed(1)} min with one idle connection open`}.`
  );
  out(
    `- \`SELECT 1\` on the idle connection afterwards: ${probeErr ? `failed, \`${probeErr.code ?? probeErr.name}\`: \`${probeErr.message}\`` : "succeeded"}.`
  );
  await c.end().catch(() => {});
  out("");
}

async function stepRestart() {
  out(`## 3. Forced compute restart mid-mutation (${LABEL}, once, last)`);
  out("");
  const { c } = await connect(SCRATCH_DB);
  const tag = `restart-${randomUUID().slice(0, 8)}`;
  await c.query("begin isolation level serializable");
  await c.query("insert into items (name, qty) values ($1, 1)", [tag]);
  await c.query("update counter set n = n + 1000 where id = 4");
  const before = Number((await c.query("select n from counter where id = 4")).rows[0].n);
  const tRestart = now();
  const r = await endpointAction("restart");
  out(
    `- Transaction open with three statements done (insert, update, select read ${before}); \`POST .../restart\`: API answered in ${ms(r.apiMs)} ms, operations \`${r.actions}\` finished after ${ms(r.opsMs)} ms.`
  );
  let err4: any, errC: any;
  try {
    await c.query("select count(*) from items");
  } catch (e) {
    err4 = e;
  }
  try {
    await c.query("commit");
  } catch (e) {
    errC = e;
  }
  out(
    `- Fourth statement: ${err4 ? `\`${err4.code ?? err4.name}\`: \`${err4.message}\`` : "succeeded (!)"}.`
  );
  out(
    `- COMMIT: ${errC ? `\`${errC.code ?? errC.name}\`: \`${errC.message}\`` : "succeeded (!)"}.`
  );
  c.end().catch(() => {});
  let attempts = 0,
    firstErr = "";
  let c2: pg.Client | undefined;
  for (;;) {
    attempts++;
    try {
      c2 = (await connect(SCRATCH_DB)).c;
      break;
    } catch (e: any) {
      if (!firstErr) firstErr = `${e.code ?? e.name}: ${e.message}`;
      await sleep(250);
    }
  }
  const reconnectMs = now() - tRestart;
  const landed = (await c2!.query("select count(*)::int n from items where name = $1", [tag]))
    .rows[0].n;
  const after = Number((await c2!.query("select n from counter where id = 4")).rows[0].n);
  await c2!.end();
  out(
    `- New connection succeeded ${ms(reconnectMs)} ms after the restart call, on attempt ${attempts}${firstErr ? ` (first failure: \`${firstErr}\`)` : ""}.`
  );
  out(
    `- Rows did not land: marker row count ${landed}, counter 4 is ${after} (was ${before} inside the transaction).`
  );
  out(`- Endpoint state now: \`${await endpointState()}\`.`);
  out("");
}

// ---------- main ----------
const started = new Date();
out(`# Neon bench results (${LABEL}), ${started.toISOString()}`);
out("");
out(
  `Host \`${HOST}\`, project \`${PROJECT}\`, endpoint \`${ENDPOINT}\`, steps: ${STEPS.join(", ")}.`
);
out("");
const admin = (await connect(ADMIN_DB)).c;
if (STEPS.includes("settings")) await stepSettings(admin);
await setupScratch(admin);
await admin.end(); // later suspend/restart cycles would kill it anyway
out("");
try {
  if (STEPS.includes("warm")) await stepWarm();
  if (STEPS.includes("cold")) await stepCold();
  if (STEPS.includes("mutation")) await stepMutation();
  if (STEPS.includes("contention")) await stepContention();
  if (STEPS.includes("conflict")) await stepConflict();
  if (STEPS.includes("cancel")) await stepCancel();
  if (STEPS.includes("lostcommit")) await stepLostCommit();
  if (STEPS.includes("provision")) await stepProvision();
  if (STEPS.includes("idle")) await stepIdle();
  if (STEPS.includes("restart")) await stepRestart();
} finally {
  const a = new Client(cfg(ADMIN_DB));
  await a.connect();
  await a.query(`drop database if exists ${SCRATCH_DB} with (force)`);
  await dropCompany(a, "company_x");
  await dropCompany(a, "company_y");
  const dbs = (await a.query("select datname from pg_database order by 1")).rows
    .map((r) => r.datname)
    .join(", ");
  const roles = (
    await a.query("select rolname from pg_roles where rolname not like 'pg_%' order by 1")
  ).rows
    .map((r) => r.rolname)
    .join(", ");
  await a.end();
  out(`## Cleanup (${LABEL})`);
  out("");
  out(
    `- Dropped \`${SCRATCH_DB}\` and the provisioning leftovers. Databases now: ${dbs}. Roles now: ${roles}.`
  );
  out(
    `- Endpoint state at exit: \`${await endpointState()}\`. Total run ${((Date.now() - started.getTime()) / 60000).toFixed(1)} min.`
  );
}
process.exit(0); // lingering cancel/proxy sockets otherwise keep the loop alive
