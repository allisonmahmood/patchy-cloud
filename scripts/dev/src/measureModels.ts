// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off globalConsole:off globalConsoleInEffect:off -- a measurement entrypoint: wall-clock timing, raw sockets and the process's own fetch pool are what it measures.
/**
 * Measures what model calls cost an execution task's process, to size `models.execution.inFlight`
 * and the outbound request limit (`BUN_CONFIG_MAX_HTTP_REQUESTS`) of the execution task and the
 * host. Run it under Bun, as production runs both, once per configuration:
 *
 *   bun --conditions=development scripts/dev/src/measureModels.ts --calls 128 --body 1024
 *
 * It starts a real supervisor and workerd, as an execution task does, and a loopback stand-in for
 * the host in this process that holds each model call until told to answer, reading and dropping
 * its body. Actions call four at a time, as the guest's scheduler lets them. It prints one JSON
 * line per phase: the supervisor process's RSS and TCP sockets, workerd's RSS and sockets, and
 * how long an outbound fetch from this process waits, as a callback the supervisor forwards
 * does once it has its place (the supervisor's health probes no longer go through fetch), while
 *
 * - `held`: `--calls` model calls sit in the proxy, each body `--body` bytes, forwarded and held;
 * - `ordinary`: `--ordinary` ordinary callbacks pass meanwhile;
 * - `answers`: every held call is answered at once, each answer `--answer` bytes;
 * - `cleanup`: as many are held again, then every connection to the host is dropped at once.
 *
 * Nothing leaves loopback, and no model provider is involved: the stand-in host answers itself.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { NodeCryptography } from "@patchy/core";
import * as Supervisor from "@patchy/execution/supervisor";
import * as WorkerHttp from "@patchy/execution/worker-http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { directLoopback } from "./directLoopback.js";

// Every request here is to loopback, and none goes through a proxy the shell names.
// oxlint-disable-next-line no-restricted-properties -- sets the exemption Bun's fetch reads; reads nothing.
Object.assign(process.env, directLoopback);
/** What the supervisor reports of a process it ended. */
type ProcessReport = Effect.Success<
  ReturnType<Supervisor.Supervisor["Service"]["stats"]>
>["reports"][number];
const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const calls = flag("calls", 64);
const body = flag("body", 1024);
const answerBytes = flag("answer", 1024);
const ordinary = flag("ordinary", 32);
const permits = flag("permits", calls);

/**
 * The stand-in host: model calls held while it holds, then answered or dropped, those arriving
 * later as well; everything else answered at once.
 */
const host = await new Promise<{
  readonly url: string;
  readonly held: () => number;
  readonly hold: () => void;
  readonly answer: () => void;
  readonly drop: () => void;
  readonly close: () => void;
}>((resolve) => {
  const held: ServerResponse[] = [];
  let mode: "hold" | "answer" | "drop" = "hold";
  const reply = (response: ServerResponse, value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, value }));
  };
  const answer = (response: ServerResponse) =>
    reply(response, { text: "x".repeat(answerBytes), usage: { inputTokens: 1, outputTokens: 1 } });
  const server = createServer((request, response) => {
    if (request.url === "/ping") return response.end("pong");
    const model = request.headers["x-patchy-model-call"] !== undefined;
    request.on("data", () => {});
    request.on("end", () => {
      if (!model) reply(response, null);
      else if (mode === "hold") held.push(response);
      else if (mode === "answer") answer(response);
      else response.socket?.destroy();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    resolve({
      url: `http://127.0.0.1:${port}/callback`,
      held: () => held.length,
      hold: () => {
        mode = "hold";
      },
      answer: () => {
        mode = "answer";
        for (const response of held.splice(0)) answer(response);
      },
      drop: () => {
        mode = "drop";
        for (const response of held.splice(0)) response.socket?.destroy();
      },
      close: () => {
        server.closeAllConnections();
        server.close();
      }
    });
  });
});

const source = `
export default { async fetch(request, env, ctx) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  const call = (op, args) => ctx.props.callbacks.call({ op, args });
  const text = "y".repeat(input.args.body);
  const ops = input.handler === "demo.models"
    ? [0, 1, 2, 3].map(() => call("models.generate", { connection: "writer", input: text, maxOutputTokens: 16 }))
    : Array.from({ length: input.args.count }, () => call("tables.get", { table: "rows" }));
  const replies = await Promise.all(ops);
  return Response.json({ ok: true, value: replies.filter((reply) => reply.ok).length });
}};`;

const run = promisify(execFile);
const sockets = async (pid: number) => {
  const { stdout } = await run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP"]).catch(() => ({
    stdout: ""
  }));
  return Math.max(0, stdout.trim().split("\n").length - 1);
};
const rssOf = async (pid: number) => {
  const { stdout } = await run("ps", ["-o", "rss=", "-p", String(pid)]).catch(() => ({
    stdout: "0"
  }));
  return Number(stdout.trim()) * 1024;
};
/**
 * How long one outbound fetch from this process takes to come back, as a forwarded callback's
 * does: five, each given up after `probeTimeoutMs` on its own, and their median. A probe queued
 * behind a full pool counts in the median as waiting at least that long, so a median it reaches
 * is a lower bound; a probe that fails any other way is counted apart and left out.
 */
const probeTimeoutMs = 2_000;
/** The median of `waits`, a given-up probe's as `Infinity`: with an even count, the middle two's. */
const medianOf = (waits: ReadonlyArray<number>) => {
  const sorted = [...waits].sort((a, b) => a - b);
  if (sorted.length === 0) return "no probe answered or timed out";
  const half = Math.floor(sorted.length / 2);
  const middle = sorted.length % 2 === 1 ? [sorted[half]!] : [sorted[half - 1]!, sorted[half]!];
  const bounded = middle.map((wait) => Math.min(wait, probeTimeoutMs));
  const value =
    Math.round((bounded.reduce((sum, wait) => sum + wait, 0) / bounded.length) * 10) / 10;
  return middle.includes(Infinity) ? `at least ${value}` : value;
};
const wait = async () => {
  const probes: Array<number | "timedOut" | "failed"> = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    probes.push(
      await fetch(host.url.replace("/callback", "/ping"), {
        signal: AbortSignal.timeout(probeTimeoutMs)
      })
        .then((response) => response.text())
        .then(
          () => Math.round((performance.now() - started) * 10) / 10,
          (error: unknown) =>
            error instanceof DOMException && error.name === "TimeoutError"
              ? ("timedOut" as const)
              : ("failed" as const)
        )
    );
  }
  return {
    outboundWaitMs: medianOf(
      probes.flatMap((probe) =>
        probe === "failed" ? [] : [probe === "timedOut" ? Infinity : probe]
      )
    ),
    probesTimedOut: probes.filter((probe) => probe === "timedOut").length,
    probesFailed: probes.filter((probe) => probe === "failed").length,
    probes
  };
};
/** Runs `work` up to `limitMs`: its time, or that it hadn't finished. */
const timed = async (work: Promise<unknown>, limitMs: number) => {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    work.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), limitMs);
    })
  ]);
  clearTimeout(timer);
  return finished ? Math.round(performance.now() - started) : `over ${limitMs}`;
};
/** Bun's full collection, so a phase's RSS is what its live work holds. */
const collect = () => {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const gc: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
  if (typeof gc === "function") gc.call(bun, true);
};
const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;
/**
 * Until `target` calls are held, or the count stops growing for `stallMs`: past the count the
 * supervisor's invokes and forwarded callbacks share, the rest wait their turn and don't reach
 * the host. Three seconds, since
 * a first round's calls can land more than a second apart, as a burst of new connections that TCP
 * retries does; with one, a first round on macOS stopped at 130 to 201 of 256 with room to spare.
 */
const stallMs = 3_000;
const settle = async (target: number) => {
  const started = performance.now();
  let last = -1;
  let since = performance.now();
  while (host.held() < target) {
    if (host.held() !== last) {
      last = host.held();
      since = performance.now();
    } else if (performance.now() - since > stallMs) break;
    await new Promise((done) => setTimeout(done, 5));
  }
  return Math.round(performance.now() - started);
};

await Effect.runPromise(
  Effect.gen(function* () {
    const maxHttpRequests = Option.getOrElse(
      yield* Config.option(Config.String("BUN_CONFIG_MAX_HTTP_REQUESTS")),
      () => "default"
    );
    const supervisor = yield* Supervisor.make({
      callbackUrls: [host.url],
      operatingLimits: {
        "execution.residency.bytes": 8 * 1024 ** 3,
        "models.execution.inFlight": permits
      }
    });
    const code = source;
    const bound = yield* supervisor.bind({
      companyId: "com_measure",
      bindingEpoch: 1,
      bundle: {
        companyId: "com_measure",
        patchId: "pat_measure",
        versionId: "ver_measure",
        sha256: createHash("sha256").update(code).digest("hex"),
        bundle: code
      }
    });
    if (bound.binding === undefined || bound.processGeneration === undefined)
      throw new Error("not bound");
    const binding = bound.binding;
    const generation = bound.processGeneration;
    const workerd = (yield* supervisor.stats({ bindingEpoch: 1 })).processes[0]!.pid;
    let serial = 0;
    /** The last phase's probes and held counts, for a kill to be read against. */
    let lastProbe: { readonly phase: string; readonly at: number } & Record<string, unknown> = {
      phase: "none",
      at: performance.now()
    };
    let invokesInFlight = 0;
    /**
     * A killed process, as the run's last line, once however many calls it ended: the supervisor's
     * report of it, once filed, beside what this run saw last, so the kill can be read against its
     * load. Every call the kill ended waits for the line before it fails.
     */
    const reportKill = yield* Effect.cached(
      Effect.gen(function* () {
        // What the run saw as the kill arrived, taken before the wait for its report can move it.
        const { at, ...probe } = lastProbe;
        const seen = {
          heldAtHost: host.held(),
          invokesInFlight,
          lastProbe: { ...probe, msBeforeKill: Math.round(performance.now() - at) }
        };
        let report: ProcessReport | undefined;
        for (let attempt = 0; attempt < 40 && report === undefined; attempt++) {
          const { reports } = yield* Effect.orDie(supervisor.stats({ bindingEpoch: 1 }));
          report = reports.find((entry) => entry.processGeneration === generation);
          if (report === undefined) yield* Effect.sleep(50);
        }
        process.stdout.write(
          `${JSON.stringify({
            phase: "killed",
            calls,
            maxHttpRequests,
            cause: report?.cause ?? "no report filed within two seconds",
            processGeneration: report?.processGeneration ?? generation,
            ranMs: report === undefined ? undefined : report.endedAt - report.startedAt,
            ...seen
          })}\n`
        );
      })
    );
    const killed = (error: Supervisor.SupervisorError) =>
      Effect.andThen(reportKill, Effect.die(error));
    /**
     * One action's call. A kill ends the run with its report; any other refusal, such as `busy`,
     * fails it as it is, the process still alive.
     */
    const invoke = (handler: string, args: Record<string, number>) => {
      invokesInFlight++;
      return Effect.runPromise(
        supervisor
          .invoke({
            bindingEpoch: 1,
            request: {
              wire: 1,
              binding,
              processGeneration: generation,
              invocationId: `inv_${++serial}`,
              attemptId: "attempt",
              deadline: Date.now() + 60_000,
              handler,
              args,
              viewer: {
                user: { id: "usr_m", name: "M", email: "m@example.test" },
                company: { id: "com_measure", name: "M", handle: "m" },
                admin: false
              },
              callback: { url: host.url, capability: "capability" }
            }
          })
          .pipe(
            Effect.catchTag("SupervisorError", (error) =>
              error.reason === "process_killed" ? killed(error) : Effect.fail(error)
            ),
            Effect.ensuring(Effect.sync(() => invokesInFlight--))
          )
      );
    };
    /**
     * One phase's line. A phase measured under load says how many calls the host held before and
     * after it was sampled; a count that moved fails the run rather than mix two loads.
     */
    const sample = async (phase: string, extra: Record<string, unknown> = {}, steady = false) => {
      const heldBefore = host.held();
      const line = {
        phase,
        calls,
        bodyBytes: body,
        answerBytes,
        permits,
        maxHttpRequests,
        supervisorRssMiB: mib(process.memoryUsage.rss()),
        supervisorSockets: await sockets(process.pid),
        workerdRssMiB: mib(await rssOf(workerd)),
        workerdSockets: await sockets(workerd),
        ...(await wait()),
        ...extra,
        heldBefore,
        heldAfter: host.held()
      };
      lastProbe = {
        phase,
        at: performance.now(),
        probes: line.probes,
        outboundWaitMs: line.outboundWaitMs,
        heldBefore,
        heldAfter: line.heldAfter
      };
      if (steady && line.heldAfter !== heldBefore)
        throw new Error(
          `The held calls moved from ${heldBefore} to ${line.heldAfter} during ${phase}`
        );
      process.stdout.write(`${JSON.stringify(line)}\n`);
    };
    yield* Effect.promise(async () => {
      collect();
      await sample("baseline");
      // Held: every action's four calls forwarded to the host and kept open there.
      const actions = Array.from({ length: Math.ceil(calls / 4) }, () =>
        invoke("demo.models", { body })
      );
      const heldMs = await settle(Math.min(calls, permits));
      await sample("held", { heldMs }, true);
      // Ordinary callbacks meanwhile, from one more action, given up on after ten seconds.
      const heldBeforeOrdinary = host.held();
      const ordinaryMs = await timed(invoke("demo.ordinary", { count: ordinary }), 10_000);
      if (host.held() !== heldBeforeOrdinary)
        throw new Error("The held calls moved while ordinary callbacks passed");
      await sample("ordinary", { ordinaryCallbacks: ordinary, ordinaryMs }, true);
      // Answers: every held call answered at once.
      let peak = process.memoryUsage.rss();
      const watch = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage.rss());
      }, 10);
      const answered = performance.now();
      host.answer();
      await Promise.all(actions);
      clearInterval(watch);
      await sample("answers", {
        drainMs: Math.round(performance.now() - answered),
        peakSupervisorRssMiB: mib(peak)
      });
      // Cleanup: as many held again, then every connection to the host dropped at once.
      host.hold();
      const again = Array.from({ length: Math.ceil(calls / 4) }, () =>
        invoke("demo.models", { body })
      );
      await settle(Math.min(calls, permits));
      const dropped = performance.now();
      host.drop();
      await Promise.all(again);
      const cleanupMs = Math.round(performance.now() - dropped);
      // Every permit came back: as many can be held again at once.
      host.hold();
      const third = Array.from({ length: Math.ceil(calls / 4) }, () =>
        invoke("demo.models", { body })
      );
      const permitsBackMs = await settle(Math.min(calls, permits));
      const heldAgain = host.held();
      host.answer();
      await Promise.all(third);
      collect();
      await sample("cleanup", { cleanupMs, permitsBackMs, heldAgain });
    });
    yield* supervisor.stop({ bindingEpoch: 1 });
  }).pipe(
    Effect.scoped,
    Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
  )
);
host.close();
process.exit(0);
