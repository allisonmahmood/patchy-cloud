/**
 * Shows, under the Bun running it, whether an execution task's supervisor keeps healthy processes
 * when callbacks to the host fill the runtime's fetch, which runs 256 at once, and when invokes
 * alone come in a burst. It starts a real supervisor and workerd and a loopback host, then runs
 * these phases, all by default or those named:
 * - `crowd`: a baseline of the probes of the process under test while it holds one call; then
 *   more held callbacks than Bun runs at once, kept past `execution.stall`, with one short call
 *   sent behind them; then every call and callback accounted for;
 * - `fan-out`: one call fanning out 400 callbacks that the host answers 8 at a time;
 * - `burst`: 352 calls at once, each holding 1.375 MiB for 1.2 s within a 3 s deadline, which
 *   only fits a process's 512 MiB if no more than 256 run at once;
 * - `stall`: a process that really stalls, which must be ended for `stall` at `execution.stall`.
 * Probes are timed from the request to the end of the body read, and only the process under
 * test's. The run fails at once if a healthy process's call is ended `process_killed`, and at the
 * end if anything it expects did not happen. Nothing outside this machine is reached.
 *
 *   bun --conditions=development scripts/dev/src/crowdedProbes.ts [crowd] [fan-out] [burst] [stall]
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off -- a loopback host paced by its own timers, wall-clock deadlines like the supervisor's own, and a Web Response wrapping a probe body already read.
import { createServer, type ServerResponse } from "node:http";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { NodeCryptography, Cryptography } from "@patchy/core";
import * as Supervisor from "@patchy/execution/supervisor";
import * as WorkerHttp from "@patchy/execution/worker-http";
import { registry } from "@patchy/limits/registry";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

type Service = Supervisor.Supervisor["Service"];
type Bound = Effect.Success<ReturnType<Service["bind"]>>;
type Called = Effect.Success<ReturnType<ReturnType<typeof calls>>>;

/** A healthy process the supervisor ended. */
class FalseKill extends Schema.TaggedError<FalseKill>()("FalseKill", { call: Schema.String }) {
  override get message() {
    return `A healthy process was ended under ${this.call}.`;
  }
}
/** Something the run expected that did not happen. */
class Unexpected extends Schema.TaggedError<Unexpected>()("Unexpected", {
  failures: Schema.Array(Schema.String)
}) {
  override get message() {
    return `Not as expected: ${this.failures.join("; ")}.`;
  }
}

/**
 * `crowd.fanOut` holds `args.callbacks` callbacks open at once and says how they ended; `spaced`
 * starts them eight at a time, 2 ms apart, so no burst overflows a listen backlog (128 on
 * macOS). `crowd.burst` holds `args.bytes` for `args.ms`, from a pool of buffers it reuses, so its
 * memory follows how many run at once rather than when garbage is collected. `crowd.spin` never
 * returns.
 */
const guest = `const pool = [];
export default { async fetch(request, env, ctx) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  if (input.handler === "crowd.spin") { while (true) {} }
  if (input.handler === "crowd.burst") {
    const held = pool.pop() ?? new Uint8Array(input.args.bytes);
    held.fill(1);
    await new Promise((resolve) => setTimeout(resolve, input.args.ms));
    pool.push(held);
    return Response.json({ ok: true, value: { ok: held.length === input.args.bytes ? 1 : 0, busy: 0, other: 0 } });
  }
  const calls = [];
  for (let index = 0; index < input.args.callbacks; index++) {
    calls.push(ctx.props.callbacks.call({ op: "hold", args: {} }));
    if (input.args.spaced && index % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const replies = await Promise.all(calls);
  const ended = { ok: 0, busy: 0, other: 0 };
  for (const reply of replies) ended[reply.ok ? "ok" : reply.code === "busy" ? "busy" : "other"]++;
  return Response.json({ ok: true, value: ended });
}};`;
const companyId = "com_crowded";
/** More callbacks than Bun's fetch runs at once: 40 calls of 8, as eight actions of eight do. */
const crowdCalls = 40;
const callbacksPerCall = 8;
const fanOut = 400;
/** Two hosts' admission burst of invokes, each holding as much as the reviewer's workload did. */
const burstCalls = 352;
const burstBytes = 1.375 * 1024 ** 2;
const burstMs = 1_200;
const burstDeadline = 3_000;
const stall = registry["execution.stall"].default;

/**
 * A loopback host counting each invocation's arrivals and answers. It holds every callback until
 * `release`, then answers each at once, or with `serve(n)` answers n at a time, 5 ms each, the
 * rest waiting at it.
 */
const host = Effect.acquireRelease(
  Effect.promise(async () => {
    const held: ServerResponse[] = [];
    const received = new Map<string, number>();
    const answered = new Map<string, number>();
    let mode: "hold" | "answer" | { readonly serving: number } = "hold";
    let inService = 0;
    let mostWaiting = 0;
    const answer = (response: ServerResponse) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, value: "answered" }));
    };
    const pump = () => {
      if (typeof mode !== "object") return;
      while (inService < mode.serving && held.length > 0) {
        const response = held.shift()!;
        inService++;
        setTimeout(() => {
          answer(response);
          inService--;
          pump();
        }, 5);
      }
    };
    const server = createServer((request, response) => {
      const invocationId = String(request.headers["x-patchy-invocation-id"]);
      received.set(invocationId, (received.get(invocationId) ?? 0) + 1);
      response.once("finish", () =>
        answered.set(invocationId, (answered.get(invocationId) ?? 0) + 1)
      );
      if (mode === "answer") return answer(response);
      held.push(response);
      mostWaiting = Math.max(mostWaiting, held.length);
      pump();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No host address");
    return {
      server,
      url: `http://127.0.0.1:${address.port}/callback`,
      received,
      answered,
      held: () => held.length,
      mostWaiting: () => mostWaiting,
      hold: () => {
        mode = "hold";
      },
      release: () => {
        mode = "answer";
        for (const response of held.splice(0)) answer(response);
      },
      serve: (serving: number) => {
        mode = { serving };
        mostWaiting = held.length;
        pump();
      }
    };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
);

/**
 * Times one version's process's probes, from the request to the end of its body, on whichever
 * client carries them: a supervisor from before the worker client sends them through fetch. A
 * process is known by the address its version's bind went to.
 */
const timedProbes = () => {
  const probes: Array<number | "timed out"> = [];
  const addresses = new Map<string, string>();
  let watched: string | undefined;
  const timing = (client: HttpClient.HttpClient) =>
    client.pipe(
      HttpClient.transform((response, request) => {
        const url = new URL(request.url);
        if (url.pathname === "/bind" && request.body._tag === "Uint8Array") {
          const { versionId } = JSON.parse(new TextDecoder().decode(request.body.body));
          addresses.set(String(versionId), url.origin);
        }
        if (url.pathname !== "/healthz" || url.origin !== addresses.get(watched ?? ""))
          return response;
        const started = performance.now();
        return response.pipe(
          Effect.flatMap((answer) =>
            answer.arrayBuffer.pipe(
              Effect.map((body) => {
                probes.push(performance.now() - started);
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(body, { status: answer.status, headers: answer.headers })
                );
              })
            )
          ),
          Effect.onInterrupt(() => Effect.sync(() => probes.push("timed out")))
        );
      })
    );
  return {
    timing,
    /** Times this version's probes from now on, forgetting any before. */
    watch: (versionId: string) => {
      watched = versionId;
      probes.length = 0;
    },
    describe: () => {
      const answered = probes.filter((probe) => probe !== "timed out").sort((a, b) => a - b);
      const timedOut = probes.length - answered.length;
      if (answered.length === 0) return `Probes: none answered; ${timedOut} timed out.`;
      const median = answered[Math.floor(answered.length / 2)]!;
      return `Probes: ${answered.length} answered, median ${median.toFixed(1)} ms, slowest ${answered.at(-1)!.toFixed(1)} ms; ${timedOut} timed out.`;
    }
  };
};

const invocation = (
  bound: Bound,
  url: string,
  invocationId: string,
  handler: string,
  deadline: number,
  args: Record<string, number | boolean> = { callbacks: 0 }
): Parameters<Service["invoke"]>[0] => {
  if (bound.binding === undefined || bound.processGeneration === undefined)
    throw new Error("The version did not load");
  return {
    bindingEpoch: bound.bindingEpoch,
    request: {
      wire: 1,
      binding: bound.binding,
      processGeneration: bound.processGeneration,
      invocationId,
      attemptId: "attempt_one",
      deadline,
      handler,
      args,
      viewer: {
        user: { id: "usr_crowded", name: "Reader", email: "reader@example.test" },
        company: { id: companyId, name: "Example", handle: "example" },
        admin: false
      },
      callback: { url, capability: "host-attempt-capability" }
    }
  };
};
/** How the guest says a call's callbacks ended. */
const decodeEnded = Schema.decodeUnknownSync(
  Schema.Struct({ ok: Schema.Number, busy: Schema.Number, other: Schema.Number })
);
const none = { ok: 0, busy: 0, other: 0 };
/**
 * A call's end: the supervisor's refusal or its process's end, or how its callbacks ended. A
 * healthy process's call ended `process_killed` fails the run at once, through `killed`.
 */
const calls =
  (supervisor: Service, killed: Deferred.Deferred<never, FalseKill>) =>
  (request: Parameters<Service["invoke"]>[0], healthy = true) =>
    supervisor.invoke(request).pipe(
      Effect.map((reply) => {
        if (reply.outcome !== "returned" || !reply.reply.ok)
          return { ended: `outcome ${reply.outcome}`, ...none };
        return { ended: "returned", ...decodeEnded(reply.reply.value) };
      }),
      Effect.catchTags({
        SupervisorError: (error) =>
          healthy && error.reason === "process_killed"
            ? Deferred.fail(killed, new FalseKill({ call: request.request.invocationId })).pipe(
                Effect.as({ ...none, ended: error.reason })
              )
            : Effect.succeed({ ...none, ended: error.reason })
      })
    );

/** When the process ended and why, if it did within `ms`; it is watched every 50 ms. */
const watchProcess = Effect.fnUntraced(function* (
  supervisor: Service,
  generation: number,
  ms: number
) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const report = (yield* supervisor.stats({ bindingEpoch: 1 })).reports.find(
      (entry) => entry.processGeneration === generation
    );
    if (report !== undefined) return { cause: report.cause, at: report.endedAt - started };
    yield* Effect.sleep(50);
  }
  return undefined;
});

/** "21 calls", "1 call". */
const callsOf = (count: number) => `${count} call${count === 1 ? "" : "s"}`;
const tally = (values: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => `${callsOf(count)} ${value}`).join(", ");
};
const mib = (bytes: number, digits = 0) => `${(bytes / 1024 ** 2).toFixed(digits)} MiB`;

const phases = new Set(process.argv.slice(2));
const runs = (phase: "crowd" | "fan-out" | "burst" | "stall") =>
  phases.size === 0 || phases.has(phase);

const program = Effect.gen(function* () {
  const cryptography = yield* Cryptography.Cryptography;
  const callbacks = yield* host;
  const probes = timedProbes();
  const setting = yield* Config.option(Config.String("BUN_CONFIG_MAX_HTTP_REQUESTS"));
  const fetches = setting._tag === "Some" ? Number(setting.value) : 256;
  yield* Console.log(
    `Bun ${process.versions.bun ?? "(not Bun)"}, BUN_CONFIG_MAX_HTTP_REQUESTS ${setting._tag === "Some" ? setting.value : "unset"}.`
  );
  const supervisor = yield* Supervisor.make({ callbackUrls: [callbacks.url], standby: true }).pipe(
    Effect.provideService(HttpClient.HttpClient, probes.timing(yield* HttpClient.HttpClient)),
    Effect.provideService(WorkerHttp.WorkerHttp, probes.timing(yield* WorkerHttp.WorkerHttp))
  );
  const killed = yield* Deferred.make<never, FalseKill>();
  const call = calls(supervisor, killed);
  const failures: string[] = [];
  const expect = (holds: boolean, failure: string) => {
    if (!holds) failures.push(failure);
  };
  yield* supervisor.bind({ companyId, bindingEpoch: 1 });
  const bind = Effect.fnUntraced(function* (versionId: string) {
    return yield* supervisor.bind({
      companyId,
      bindingEpoch: 1,
      bundle: {
        companyId,
        patchId: "pat_crowded",
        versionId,
        sha256: yield* cryptography.sha256(guest),
        bundle: guest
      }
    });
  });
  /** Every callback of these calls arrived at the host, and was answered, `each` times. */
  const accounted = (ids: ReadonlyArray<string>, each: number) => {
    const arrivals = ids.map((invocationId) => callbacks.received.get(invocationId) ?? 0);
    const answers = ids.map((invocationId) => callbacks.answered.get(invocationId) ?? 0);
    expect(
      arrivals.every((count) => count === each) && answers.every((count) => count === each),
      `every call's ${each} callbacks to arrive and be answered once`
    );
    return `Arrivals at the host: ${arrivals.reduce((total, count) => total + count, 0)}; ${tally(arrivals.map((count) => (count === 0 ? "with none" : `with ${count}`)))}. Answers: ${answers.reduce((total, count) => total + count, 0)}.`;
  };
  const healthy: Array<{ readonly name: string; readonly bound: Bound }> = [];

  const crowd = Effect.gen(function* () {
    // A baseline: the process under test holding a single call.
    const crowded = yield* bind("ver_crowded");
    healthy.push({ name: "the crowded process", bound: crowded });
    probes.watch("ver_crowded");
    callbacks.hold();
    const single = yield* call(
      invocation(crowded, callbacks.url, "inv_baseline", "crowd.fanOut", Date.now() + 60_000, {
        callbacks: 1
      })
    ).pipe(Effect.forkChild);
    yield* Effect.sleep(3_000);
    yield* Console.log(`Baseline, one call held 3000 ms. ${probes.describe()}`);
    callbacks.release();
    yield* Fiber.join(single);

    // More held callbacks than Bun runs at once, past the stall window, and a short call behind.
    yield* Console.log(
      `Crowd: ${crowdCalls} calls of ${callbacksPerCall} callbacks each, ${crowdCalls * callbacksPerCall} callbacks held ${stall + 2_000} ms.`
    );
    callbacks.hold();
    const deadline = Date.now() + 60_000;
    const ids = Array.from({ length: crowdCalls }, (_, index) => `inv_crowd_${index}`);
    // Spaced, so no burst of connections overflows the host's listen backlog (128 on macOS).
    const fibers = yield* Effect.forEach(ids, (invocationId) =>
      call(
        invocation(crowded, callbacks.url, invocationId, "crowd.fanOut", deadline, {
          callbacks: callbacksPerCall
        })
      ).pipe(
        Effect.forkChild,
        Effect.tap(() => Effect.sleep(25))
      )
    );
    yield* Effect.sleep(1_000);
    probes.watch("ver_crowded");
    const watching = yield* watchProcess(
      supervisor,
      crowded.processGeneration!,
      stall + 2_000
    ).pipe(Effect.forkChild);
    yield* Effect.sleep(1_000);
    const queryDeadline = registry["tier2.query.deadline"].default;
    const sent = Date.now();
    const short = yield* call(
      invocation(crowded, callbacks.url, "inv_short", "crowd.fanOut", sent + queryDeadline)
    ).pipe(Effect.map((end) => ({ end, ms: Date.now() - sent })));
    const ended = yield* Fiber.join(watching);
    yield* Console.log(
      ended === undefined
        ? "  The process lived."
        : `  The process was ended (${ended.cause}) ${ended.at} ms into the hold.`
    );
    expect(ended === undefined, "the crowded process to live");
    yield* Console.log(`  ${probes.describe()}`);
    yield* Console.log(
      `  A short call sent behind the crowd, ${queryDeadline} ms deadline: ${short.end.ended}, ${short.ms} ms after it was sent.`
    );
    expect(
      short.end.ended === "returned" && short.ms < queryDeadline,
      "the short call to return within its deadline"
    );
    const holding = callbacks.held();
    yield* Console.log(`  The host was holding ${holding} callbacks: fetch runs ${fetches}.`);
    expect(holding === fetches, `fetch's queue to fill, ${fetches} callbacks held`);
    callbacks.release();
    const crowdEnded: ReadonlyArray<Called> = yield* Fiber.joinAll(fibers);
    const sum = (key: "ok" | "busy" | "other") =>
      crowdEnded.reduce((total, end) => total + end[key], 0);
    yield* Console.log(`  Calls: ${tally(crowdEnded.map((end) => end.ended))}.`);
    yield* Console.log(
      `  Callbacks of returned calls: ${sum("ok")} answered, ${sum("busy")} busy, ${sum("other")} other.`
    );
    expect(
      crowdEnded.every((end) => end.ended === "returned" && end.ok === callbacksPerCall),
      "every crowd call to return with all its callbacks answered"
    );
    yield* Console.log(`  ${accounted(ids, callbacksPerCall)}`);
  });

  const wide = Effect.gen(function* () {
    const fanned = yield* bind("ver_fan_out");
    healthy.push({ name: "the fanning-out process", bound: fanned });
    callbacks.serve(8);
    const started = Date.now();
    const end = yield* call(
      invocation(fanned, callbacks.url, "inv_fan_out", "crowd.fanOut", Date.now() + 60_000, {
        callbacks: fanOut,
        spaced: true
      })
    );
    yield* Console.log(
      `Fan-out: one call of ${fanOut} callbacks, the host answering 8 at a time: ${end.ended}, ${end.ok} answered, ${end.busy} busy, ${end.other} other, in ${Date.now() - started} ms; at most ${callbacks.mostWaiting()} waited at the host.`
    );
    expect(end.ended === "returned" && end.ok === fanOut, "all 400 callbacks to be answered");
    yield* Console.log(`  ${accounted(["inv_fan_out"], fanOut)}`);
  });

  const burst = Effect.gen(function* () {
    const bursting = yield* bind("ver_burst");
    healthy.push({ name: "the bursting process", bound: bursting });
    const pid = (yield* supervisor.stats({ bindingEpoch: 1 })).processes.find(
      (entry) => entry.processGeneration === bursting.processGeneration
    )!.pid;
    let peak = 0;
    const sampling = yield* Effect.gen(function* () {
      while (true) {
        const sampled = (yield* supervisor.stats({ bindingEpoch: 1 })).processes.find(
          (entry) => entry.pid === pid
        );
        peak = Math.max(peak, sampled?.rssBytes ?? 0, sampled?.peakRssBytes ?? 0);
        yield* Effect.sleep(50);
      }
    }).pipe(Effect.forkChild);
    const started = Date.now();
    const deadline = started + burstDeadline;
    const ended = yield* Effect.forEach(
      Array.from({ length: burstCalls }, (_, index) => `inv_burst_${index}`),
      (invocationId) =>
        call(
          invocation(bursting, callbacks.url, invocationId, "crowd.burst", deadline, {
            bytes: burstBytes,
            ms: burstMs
          })
        ).pipe(Effect.map((end) => ({ ...end, ms: Date.now() - started }))),
      { concurrency: "unbounded" }
    );
    yield* Effect.sleep(200);
    yield* Fiber.interrupt(sampling);
    yield* Console.log(
      `Burst: ${burstCalls} calls at once, each holding ${mib(burstBytes, 3)} for ${burstMs} ms, ${burstDeadline} ms deadline: ${tally(ended.map((end) => end.ended))}; the last ended ${Math.max(...ended.map((end) => end.ms))} ms in; the process peaked at ${mib(peak)}.`
    );
    expect(
      ended.every((end) => end.ended === "returned" && end.ok === 1),
      "every burst call to return"
    );
  });

  const stalling = Effect.gen(function* () {
    const spinning = yield* bind("ver_spinning");
    const spun = Date.now();
    yield* call(
      invocation(spinning, callbacks.url, "inv_spin", "crowd.spin", spun + 60_000),
      false
    ).pipe(Effect.forkChild);
    const stalled = yield* watchProcess(supervisor, spinning.processGeneration!, stall + 5_000);
    yield* Console.log(
      stalled === undefined
        ? `Stall: a spinning call's process was still running ${stall + 5_000} ms later.`
        : `Stall: a spinning call's process was ended (${stalled.cause}) ${stalled.at} ms after the call was sent.`
    );
    expect(stalled?.cause === "stall", "the spinning process to be ended for stall");
  });

  yield* Effect.gen(function* () {
    if (runs("crowd")) yield* crowd;
    if (runs("fan-out")) yield* wide;
    if (runs("burst")) yield* burst;
    if (runs("stall")) yield* stalling;
  }).pipe(Effect.raceFirst(Deferred.await(killed)));
  // Their calls have finished; a healthy process is still resident, with no report.
  const { processes, reports } = yield* supervisor.stats({ bindingEpoch: 1 });
  for (const { name, bound } of healthy)
    expect(
      processes.some((entry) => entry.processGeneration === bound.processGeneration) &&
        !reports.some((entry) => entry.processGeneration === bound.processGeneration),
      `${name} to still be resident`
    );
  if (failures.length > 0) return yield* new Unexpected({ failures });
  yield* Console.log("As expected.");
}).pipe(
  Effect.scoped,
  Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
);

NodeRuntime.runMain(program);
