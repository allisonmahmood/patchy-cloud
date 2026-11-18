// PROTOTYPE: the slot load test for model calls. Signs in the models scenario's dev people, opens
// request-triage as each in headless Chromium, and fires one scenario's action calls through the
// page (`globalThis.patchyLoad`, from the patch's src/main.tsx), recording what each page saw and
// when. Then it reads this run's wide events and the fake provider's lines from dev.log, samples
// the server's memory throughout, and prints one table.
//
// From the checkout, with `pnpm dev up models` running (set PATCHY_DEV_SLOT_MODE and
// PATCHY_DEV_MODEL_GATE on `up` to pick the mode and the gate):
//   node scripts/dev/load-models.mjs <one|S1|S2|S2s|S3|S4|S5|S6|park> [--label <name>] [--writes <n>]
//     [--count <n>] [--via page|http] [--out <dir>]
// `--writes` is S4's inserts after each answer (40 by default); `--count` is how many calls
// `park` parks (300 by default). Results go to `<out>/<label>-<scenario>-<time>/`.
// `--via http` sends each call as the page's own request, captured once from the page and replayed
// with its cookies and headers from Node: a dev instance speaks HTTP/1.1, so Chromium keeps at most
// six requests open to it per person, which caps one page at about five calls in flight. Production
// serves browsers over HTTP/2, where the page's own bound (`frame.outstanding`, 32) is what applies.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const scenario = args[0];
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const label = option("label", "run");
const writes = Number(option("writes", "40"));
const count = Number(option("count", "300"));
const outRoot = option("out", ".local/slots");
const via = option("via", "page");

const plan = JSON.parse(readFileSync(".local/dev/plan.json", "utf8"));
const host = plan.apiUrl;
// Every write here goes to this checkout's own dev instance, never anywhere else.
if (!new URL(host).hostname.endsWith(".localhost") && new URL(host).hostname !== "localhost")
  throw new Error(`refusing a host that isn't local: ${host}`);
const logFile = path.join(plan.stateDir, "dev.log");
const serverPid = plan.pids.server;
const people = JSON.parse(readFileSync("scenarios/models/scenario.json", "utf8")).people.map(
  (person) => person.email
);
const patchPath = "/juniper/request-triage";

// ---------- the scenarios: who calls what, when (ms after the start) ----------

const generate = (delayMs, extra = {}) => ({
  op: "model",
  args: { kind: "generate", delayMs, at: 0, writes: 0, ...extra }
});
const scenarios = {
  // One 1 s call, then `--writes` inserts, to time the work S4 does after its answer.
  one: () => [{ person: 0, at: 0, ...generate(1_000, { writes }) }],
  // Ten people each start one 45 s model call within a second.
  S1: () =>
    Array.from({ length: 10 }, (_, i) => ({
      person: i,
      at: Math.random() * 1000,
      ...generate(45_000)
    })),
  // One person fires twenty 20 s model calls at once.
  S2: () => Array.from({ length: 20 }, () => ({ person: 0, at: 0, ...generate(20_000) })),
  // The same twenty, 100 ms apart.
  S2s: () =>
    Array.from({ length: 20 }, (_, i) => ({ person: 0, at: i * 100, ...generate(20_000) })),
  // Eight people park 30 s calls; five others run a quick action every second for 20 s.
  S3: () => [
    ...Array.from({ length: 8 }, (_, i) => ({ person: i, at: i * 100, ...generate(30_000) })),
    ...Array.from({ length: 5 }, (_, p) =>
      Array.from({ length: 20 }, (_, k) => ({
        person: 8 + p,
        at: 2_000 + k * 1_000 + p * 50,
        op: "quick",
        args: {}
      }))
    ).flat()
  ],
  // Thirty calls parked on a model that answers them all at one instant, then ~200 ms of writes.
  S4: (start) =>
    Array.from({ length: 30 }, (_, i) => ({
      person: i % 10,
      at: i * 100,
      ...generate(0, { at: start + 15_000, writes })
    })),
  // Two hundred ~400 ms decision calls from ten people over ten seconds.
  S5: () =>
    Array.from({ length: 200 }, (_, i) => ({
      person: i % 10,
      at: i * 50,
      op: "model",
      args: { kind: "decide", delayMs: 400, at: 0, writes: 0 }
    })),
  // Two model calls in flight in one action while the company's slots are full: the first answers
  // while eight holds fill every slot, the second starts and answers before they end. Then probes,
  // after everything has ended: eight holds from four others fill the company's slots exactly, two
  // from the dual action's own person fill theirs, and one quick action reads the running count it
  // joins. A leaked slot refuses one hold in a probe and reads one more running.
  S6: () => [
    {
      person: 0,
      at: 0,
      group: "dual",
      op: "dual",
      args: { firstDelayMs: 300, secondAfterMs: 1_000, secondDelayMs: 300 }
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      person: 1 + Math.floor(i / 2),
      at: 200 + i * 10,
      group: "fill",
      op: "hold",
      args: { ms: 4_000 }
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      person: 6 + Math.floor(i / 2),
      at: 8_000 + i * 10,
      group: "probe company",
      op: "hold",
      args: { ms: 1_000 }
    })),
    ...[0, 1].map((i) => ({
      person: 0,
      at: 10_000 + i * 10,
      group: "probe person",
      op: "hold",
      args: { ms: 500 }
    })),
    { person: 5, at: 12_000, group: "probe count", op: "quick", args: {} }
  ],
  // What parking costs the host: `count` calls parked together, then answered at one instant,
  // while one other person runs a quick action every half second.
  park: (start) => {
    const answerAt = start + count * 20 + 20_000;
    return [
      ...Array.from({ length: count }, (_, i) => ({
        person: i % 15,
        at: i * 20,
        ...generate(0, { at: answerAt })
      })),
      ...Array.from({ length: Math.ceil((answerAt - start + 10_000) / 500) }, (_, k) => ({
        person: 15,
        at: k * 500,
        op: "quick",
        args: {}
      }))
    ];
  }
};
if (!(scenario in scenarios))
  throw new Error(`scenario is one of ${Object.keys(scenarios).join(", ")}`);

// ---------- the host's memory ----------

/** The server's resident memory and its descendants' (supervisor, workerd), in MiB. */
const memory = () => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
  let descendants = 0;
  const stack = [...(children.get(serverPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    descendants += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return {
    server: Math.round((rss.get(serverPid) ?? 0) / 1024),
    children: Math.round(descendants / 1024)
  };
};

// ---------- the pages ----------

const browser = await chromium.launch();
const needed = [...new Set(scenarios[scenario](Date.now()).map((call) => call.person))].sort(
  (a, b) => a - b
);
if (needed.at(-1) >= people.length)
  throw new Error(`the scenario needs ${needed.at(-1) + 1} people`);
const frames = new Map();
const callers = new Map();
/** The page's own request for `load.quick`, replayed for any `load.*` call from Node. */
const replay = async (context, frame) => {
  const captured = new Promise((resolve) => {
    const listener = async (request) => {
      if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/runtime/call"))
        return;
      const body = request.postDataJSON();
      if (body?.args?.handler !== "load.quick") return;
      context.off("request", listener);
      resolve({ url: request.url(), headers: await request.allHeaders(), body });
    };
    context.on("request", listener);
  });
  await frame.evaluate(() => globalThis.patchyLoad.quick());
  const template = await captured;
  const headers = Object.fromEntries(
    Object.entries(template.headers).filter(
      ([name]) => !["content-length", "host"].includes(name) && !name.startsWith(":")
    )
  );
  return async (op, input) => {
    const started = performance.now();
    const response = await context.request.post(template.url, {
      headers,
      data: { ...template.body, args: { handler: `load.${op}`, args: input } },
      timeout: 180_000
    });
    const ms = performance.now() - started;
    const reply = await response.json().catch(() => null);
    if (reply?.ok === true) return { ms, code: "ok" };
    if (reply?.ok === false)
      return {
        ms,
        code: reply.code,
        limitId: reply.limitId,
        scope: reply.scope,
        details: reply.details,
        retryAfter: reply.retryAfter,
        message: reply.error
      };
    return { ms, code: `http_${response.status()}` };
  };
};
await Promise.all(
  needed.map(async (index) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(
      `${host}/dev/sign-in?as=${encodeURIComponent(people[index])}&return=${encodeURIComponent(patchPath)}`
    );
    for (let attempt = 0; attempt < 240; attempt++) {
      for (const frame of page.frames()) {
        try {
          if (await frame.evaluate(() => typeof globalThis.patchyLoad === "object")) {
            frames.set(index, frame);
            if (via === "http") callers.set(index, await replay(context, frame));
            return;
          }
        } catch {}
      }
      await page.waitForTimeout(250);
    }
    throw new Error(`${people[index]}: the patch frame never offered patchyLoad`);
  })
);

// ---------- the run ----------

const logStart = statSync(logFile).size;
const before = memory();
const samples = [];
const sampler = setInterval(() => samples.push({ at: Date.now(), ...memory() }), 500);
const start = Date.now() + 500;
const calls = scenarios[scenario](start);
const results = await Promise.all(
  calls.map(
    (call, index) =>
      new Promise((resolve) => {
        setTimeout(
          async () => {
            const firedAt = Date.now();
            const frame = frames.get(call.person);
            const seen = await (
              via === "http"
                ? callers.get(call.person)(call.op, call.args)
                : frame.evaluate(
                    ([op, input]) => globalThis.patchyLoad[op](input),
                    [call.op, call.args]
                  )
            ).catch((error) => ({
              ms: Date.now() - firedAt,
              code: "driver",
              message: String(error)
            }));
            resolve({
              index,
              person: call.person,
              op: call.op,
              group: call.group ?? call.op,
              firedAt: firedAt - start,
              ...seen
            });
          },
          Math.max(0, start + call.at - Date.now())
        );
      })
  )
);
const lastAnswer = Date.now();
await new Promise((resolve) => setTimeout(resolve, 3_000));
clearInterval(sampler);
const after = memory();
await browser.close();

// ---------- what the host recorded ----------

const length = statSync(logFile).size - logStart;
const bytes = Buffer.alloc(length);
const handle = openSync(logFile, "r");
readSync(handle, bytes, 0, length, logStart);
closeSync(handle);
const lines = bytes.toString("utf8").split("\n");
const events = [];
const fake = [];
const problems = [];
for (const line of lines) {
  const server = /\[server\] (\{.*\})\s*$/.exec(line);
  if (server !== null) {
    try {
      const event = JSON.parse(server[1]);
      if (
        event.type === "request" &&
        typeof event.handler === "string" &&
        event.handler.startsWith("load.")
      )
        events.push(event);
      else if (event.level === "ERROR" || event.level === "FATAL")
        problems.push(line.slice(0, 400));
    } catch {}
    continue;
  }
  const model =
    /^(\S+) \[models\] \S+ model=\S*load\S* status=(\S+) durationMs=(\d+) closedEarly=(\w+)/.exec(
      line
    );
  if (model !== null) {
    const closed = Date.parse(model[1]);
    fake.push({
      opened: closed - Number(model[3]),
      closed,
      status: model[2],
      closedEarly: model[4] === "true"
    });
    continue;
  }
  if (/\[server\]/.test(line) && /error|fatal|defect|exception/i.test(line))
    problems.push(line.slice(0, 400));
}
const sweep = (intervals) => {
  const edges = intervals.flatMap(({ opened, closed }) => [
    [opened, 1],
    [closed, -1]
  ]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, step] of edges) peak = Math.max(peak, (now += step));
  return peak;
};

// ---------- the table ----------

const percentile = (values, p) => {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
};
const kindOf = (result) =>
  result.code === "ok"
    ? "ok"
    : result.code === "busy" && String(result.limitId).startsWith("tier2.actions")
      ? "busySlot"
      : result.code === "busy" && String(result.limitId).startsWith("tier2.models")
        ? "poolRefused"
        : result.code === "busy" && String(result.limitId).startsWith("models.calls")
        ? result.details?.waitedMs > 0
          ? "gateWaited"
          : "gateRefused"
        : result.code === "timeout"
          ? "timeout"
          : result.code === "handler_timeout"
            ? "handlerTimeout"
            : `other:${result.code}`;
const max = (values) => (values.length === 0 ? 0 : Math.max(...values));
const rows = [];
for (const group of [...new Set(results.map((result) => result.group))]) {
  const mine = results.filter((result) => result.group === group);
  const op = mine[0].op;
  const mineEvents = events.filter((event) => event.handler === `load.${op}`);
  // After the last model call answered (and, in park-r2, was let go): the action's own work.
  const after = mineEvents
    .filter((event) => (event.slots?.resumedAt ?? 0) > 0 && event.outcome === "success")
    .map((event) => ({ opened: event.slots.resumedAt, closed: event.startedAt + event.durationMs }));
  const kinds = {};
  for (const result of mine) kinds[kindOf(result)] = (kinds[kindOf(result)] ?? 0) + 1;
  const slots = mineEvents.map((event) => event.slots).filter(Boolean);
  const gate = mineEvents.flatMap((event) => event.modelCalls ?? []);
  rows.push({
    op: group,
    calls: mine.length,
    ok: kinds.ok ?? 0,
    busySlot: kinds.busySlot ?? 0,
    poolRefused: kinds.poolRefused ?? 0,
    gateRefused: kinds.gateRefused ?? 0,
    gateWaited: kinds.gateWaited ?? 0,
    timeout: kinds.timeout ?? 0,
    handlerTimeout: kinds.handlerTimeout ?? 0,
    other: Object.entries(kinds)
      .filter(([kind]) => kind.startsWith("other:"))
      .map(([kind, n]) => `${kind.slice(6)}×${n}`)
      .join(" "),
    p50: percentile(
      mine.map((result) => result.ms),
      50
    ),
    p95: percentile(
      mine.map((result) => result.ms),
      95
    ),
    okP50: percentile(
      mine.filter((result) => result.code === "ok").map((result) => result.ms),
      50
    ),
    okP95: percentile(
      mine.filter((result) => result.code === "ok").map((result) => result.ms),
      95
    ),
    peakRunning: max(events.map((event) => event.slots?.running ?? 0)),
    peakParked: max(events.map((event) => event.slots?.parked ?? 0)),
    peakHeld: max(events.map((event) => event.slots?.held ?? 0)),
    resumeWaitP95: percentile(
      slots.map((slot) => slot.resumeWaitMs),
      95
    ),
    resumeWaitMax: Math.round(max(slots.map((slot) => slot.resumeWaitMs))),
    // The action's time neither parked nor held: its own work, writes included.
    workP50: percentile(
      slots.map(
        (slot, i) =>
          (mineEvents.filter((event) => event.slots)[i].durationMs ?? 0) -
          slot.parkedMs -
          slot.resumeWaitMs
      ),
      50
    ),
    workP95: percentile(
      slots.map(
        (slot, i) =>
          (mineEvents.filter((event) => event.slots)[i].durationMs ?? 0) -
          slot.parkedMs -
          slot.resumeWaitMs
      ),
      95
    ),
    afterPeak: sweep(after),
    afterP50: percentile(
      after.map((span) => span.closed - span.opened),
      50
    ),
    afterP95: percentile(
      after.map((span) => span.closed - span.opened),
      95
    ),
    peakPooled: max(events.map((event) => event.slots?.pooled ?? 0)),
    gateWaitMax: Math.round(max(gate.map((call) => call.gateWaitMs ?? 0))),
    gateWaitingPeak: max(gate.map((call) => call.gateWaiting ?? 0)),
    events: mineEvents.length
  });
}
const summary = {
  scenario,
  label,
  via,
  mode: events.find((event) => event.slots !== undefined)?.slots.mode ?? "?",
  rows,
  // The running count the run's last action joined: 1 unless slots are held by something that ended.
  lastRunningSeen:
    [...events].sort((a, b) => a.startedAt - b.startedAt).at(-1)?.slots?.running ?? null,
  fakePeakInFlight: sweep(fake),
  fakeRequests: fake.length,
  fakeClosedEarly: fake.filter((entry) => entry.closedEarly).length,
  memoryMiB: {
    before,
    peak: {
      server: max(samples.map((sample) => sample.server)),
      children: max(samples.map((sample) => sample.children))
    },
    after
  },
  wallMs: lastAnswer - start,
  problems: problems.slice(0, 20),
  problemCount: problems.length
};

const columns = [
  ["op", "op"],
  ["calls", "calls"],
  ["ok", "ok"],
  ["busy slot", "busySlot"],
  ["pool refused", "poolRefused"],
  ["gate refused", "gateRefused"],
  ["gate waited out", "gateWaited"],
  ["timeout", "timeout"],
  ["handler_timeout", "handlerTimeout"],
  ["other", "other"],
  ["p50 ms", "p50"],
  ["p95 ms", "p95"],
  ["ok p50", "okP50"],
  ["ok p95", "okP95"],
  ["peak running", "peakRunning"],
  ["peak parked", "peakParked"],
  ["peak held", "peakHeld"],
  ["peak pooled", "peakPooled"],
  ["after-answer peak / p50 / p95", (row) => `${row.afterPeak}/${row.afterP50}/${row.afterP95}`],
  ["resume wait p95/max", (row) => `${row.resumeWaitP95}/${row.resumeWaitMax}`],
  ["work p50/p95", (row) => `${row.workP50}/${row.workP95}`],
  ["gate wait max", "gateWaitMax"],
  ["gate waiting peak", "gateWaitingPeak"]
];
const cell = (row, key) => String(typeof key === "function" ? key(row) : row[key]);
const table = [
  `${scenario} · ${summary.mode} · ${label} · via ${via}`,
  `| ${columns.map(([name]) => name).join(" | ")} |`,
  `| ${columns.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${columns.map(([, key]) => cell(row, key)).join(" | ")} |`),
  `fake: ${summary.fakeRequests} requests, peak ${summary.fakePeakInFlight} in flight, ${summary.fakeClosedEarly} closed early · ` +
    `memory MiB server ${before.server} → peak ${summary.memoryMiB.peak.server} → ${after.server}, ` +
    `children ${before.children} → peak ${summary.memoryMiB.peak.children} → ${after.children} · ` +
    `${summary.problemCount} problem lines · last action joined ${summary.lastRunningSeen} running`
].join("\n");
console.log(table);

const out = path.join(
  outRoot,
  `${label}-${scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "table.md"), `${table}\n`);
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
writeFileSync(
  path.join(out, "events.jsonl"),
  events.map((event) => JSON.stringify(event)).join("\n")
);
writeFileSync(path.join(out, "memory.json"), JSON.stringify(samples));
console.log(`results: ${out}`);
