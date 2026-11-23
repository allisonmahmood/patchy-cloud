/**
 * Shows, under the Bun running it, whether an execution task's supervisor keeps healthy processes
 * while its invokes and forwarded callbacks fill the slots they share: as many as Bun's fetch runs
 * at once, 256 unless `BUN_CONFIG_MAX_HTTP_REQUESTS` says otherwise. It starts a real supervisor
 * and workerd and a loopback host, then runs these phases, all by default or those named:
 * - `crowd`: a baseline of the process under test holding one call; then more callbacks than
 *   the shared slots admit, held past `execution.stall`, with a short call sent behind them that
 *   waits its turn; then every call and callback accounted for;
 * - `fan-out`: one call fanning out 400 callbacks that the host answers 8 at a time;
 * - `burst`: 352 calls at once, each holding 1.375 MiB for 1.2 s within a 3 s deadline, which
 *   fits a process's 512 MiB only if no more than 256 run at once;
 * - `mixed`: twenty calls retaining 100 MiB between them and holding 160 callbacks, then 200
 *   calls each holding 2 MiB for 1.2 s, which fit only in the slots the twenty leave; the most
 *   invokes and callbacks in flight at once must stay within the slots;
 * - `queued`: 256 long calls to one process, then a short call to a second process that waits
 *   for a slot past its deadline and a second, and must not get its process ended;
 * - `stall`: a process that really stalls, ended for `stall` at `execution.stall`.
 * Probes are timed from the request to the end of the body read, and only the process under
 * test's; one counts as answered only with a 200, and any other end fails its phase. The run fails at once if a healthy process's call is ended `process_killed`, and at the
 * end if anything it expects did not happen. Nothing outside this machine is reached.
 *
 *   bun --conditions=development scripts/dev/src/crowdedProbes.ts [phase...]
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalJsonInEffect:off -- a loopback host paced by its own timers and reading callback bodies, wall-clock deadlines like the supervisor's own, and a Web Response wrapping a probe body already read.
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
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
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
 * `crowd.fanOut` waits `args.after` ms, keeps `args.retain` bytes, then holds `args.callbacks`
 * callbacks open at once, each with its sequence number, and says how they ended; `spaced`
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
  if (input.args.after) await new Promise((resolve) => setTimeout(resolve, input.args.after));
  const retained = new Uint8Array(input.args.retain ?? 0).fill(1);
  const calls = [];
  for (let seq = 0; seq < (input.args.callbacks ?? 0); seq++) {
    calls.push(ctx.props.callbacks.call({ op: "hold", args: { seq } }));
    if (input.args.spaced && seq % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const replies = await Promise.all(calls);
  const ended = { ok: 0, busy: 0, other: retained.length === (input.args.retain ?? 0) ? 0 : 1 };
  for (const reply of replies) ended[reply.ok ? "ok" : reply.code === "busy" ? "busy" : "other"]++;
  return Response.json({ ok: true, value: ended });
}};`;
const companyId = "com_crowded";
/** More callbacks than the shared slots admit: 40 calls of 8, as eight actions of eight do. */
const crowdCalls = 40;
const callbacksPerCall = 8;
const fanOut = 400;
/** Two hosts' admission burst of invokes, each holding as much as the reviewer's workload did. */
const burstCalls = 352;
const burstBytes = 1.375 * 1024 ** 2;
const burstMs = 1_200;
const burstDeadline = 3_000;
const stall = registry["execution.stall"].default;
const queryDeadline = registry["tier2.query.deadline"].default;
/** Every probe of the process under test is answered within this, through its body. */
const probeBound = 100;
const phaseNames = ["crowd", "fan-out", "burst", "mixed", "queued", "stall"] as const;
type Phase = (typeof phaseNames)[number];

/**
 * A loopback host counting arrivals and answers by callback id, `<invocation>#<sequence>`. It
 * holds every callback until `release`, then answers each at once, or with `serve(n)` answers n
 * at a time, 5 ms each, the rest waiting at it.
 */
const host = Effect.acquireRelease(
  Effect.promise(async () => {
    const held: ServerResponse[] = [];
    const received = new Map<string, number>();
    const answered = new Map<string, number>();
    let mode: "hold" | "answer" | { readonly serving: number } = "hold";
    let inService = 0;
    let mostWaiting = 0;
    const count = (counts: Map<string, number>, id: string) =>
      counts.set(id, (counts.get(id) ?? 0) + 1);
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
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        const invocationId = String(request.headers["x-patchy-invocation-id"]);
        let sequence: string;
        try {
          sequence = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).args.seq);
        } catch {
          sequence = "unreadable";
        }
        const id = `${invocationId}#${sequence}`;
        count(received, id);
        response.once("finish", () => count(answered, id));
        if (mode === "answer") return answer(response);
        held.push(response);
        mostWaiting = Math.max(mostWaiting, held.length);
        pump();
      });
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
 * Watches both clients, whichever carries what (a supervisor from before the worker client sends
 * everything through fetch): times one version's process's probes, from the request to the end of
 * its body, and counts invokes in flight. A process is known by the address its bind went to.
 */
const watching = () => {
  const probes: Array<number | "timed out" | "failed"> = [];
  const addresses = new Map<string, string>();
  let watched: string | undefined;
  let invokes = 0;
  let forwarded = 0;
  let peak = 0;
  /** Counts a request in flight from its hand-off until its answer's body has been read. */
  const inFlight = (
    response: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
    request: HttpClientRequest.HttpClientRequest,
    kind: "invoke" | "callback"
  ) =>
    Effect.suspend(() => {
      if (kind === "invoke") invokes++;
      else forwarded++;
      peak = Math.max(peak, invokes + forwarded);
      return response.pipe(
        Effect.flatMap((answer) =>
          answer.arrayBuffer.pipe(
            Effect.map((body) =>
              HttpClientResponse.fromWeb(
                request,
                new Response(body, { status: answer.status, headers: answer.headers })
              )
            )
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (kind === "invoke") invokes--;
            else forwarded--;
          })
        )
      );
    });
  const watch = (client: HttpClient.HttpClient) =>
    client.pipe(
      HttpClient.transform((response, request) => {
        const url = new URL(request.url);
        if (url.pathname === "/bind" && request.body._tag === "Uint8Array") {
          const { versionId } = JSON.parse(new TextDecoder().decode(request.body.body));
          addresses.set(String(versionId), url.origin);
        }
        if (url.pathname === "/invoke") return inFlight(response, request, "invoke");
        if (url.pathname === "/callback") return inFlight(response, request, "callback");
        if (url.pathname !== "/healthz" || url.origin !== addresses.get(watched ?? ""))
          return response;
        // Answered only with a 200 and its whole body; anything else is a failed probe.
        const started = performance.now();
        return response.pipe(
          Effect.flatMap((answer) =>
            answer.arrayBuffer.pipe(
              Effect.map((body) => {
                probes.push(answer.status === 200 ? performance.now() - started : "failed");
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(body, { status: answer.status, headers: answer.headers })
                );
              })
            )
          ),
          Effect.tapError(() => Effect.sync(() => probes.push("failed"))),
          Effect.onInterrupt(() => Effect.sync(() => probes.push("timed out")))
        );
      })
    );
  return {
    watch,
    invokesInFlight: () => invokes,
    /** The most invokes and forwarded callbacks in flight at once since the last reset. */
    peakInFlight: () => peak,
    resetPeak: () => {
      peak = invokes + forwarded;
    },
    /** Times this version's probes from now on, forgetting any before. */
    probesOf: (versionId: string) => {
      watched = versionId;
      probes.length = 0;
    },
    /** The probes so far, and whether every one was answered 200 within the bound. */
    probes: () => {
      const answered = probes
        .filter((probe): probe is number => typeof probe === "number")
        .sort((a, b) => a - b);
      const timedOut = probes.filter((probe) => probe === "timed out").length;
      const failed = probes.filter((probe) => probe === "failed").length;
      const slowest = answered.at(-1) ?? Number.POSITIVE_INFINITY;
      return {
        within: timedOut === 0 && failed === 0 && answered.length > 0 && slowest <= probeBound,
        text:
          answered.length === 0
            ? `Probes: none answered; ${timedOut} timed out, ${failed} failed.`
            : `Probes: ${answered.length} answered 200, median ${answered[Math.floor(answered.length / 2)]!.toFixed(1)} ms, slowest ${slowest.toFixed(1)} ms; ${timedOut} timed out, ${failed} failed.`
      };
    }
  };
};

const invocation = (
  bound: Bound,
  url: string,
  invocationId: string,
  handler: string,
  deadline: number,
  args: Record<string, number | boolean> = {}
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

const program = Effect.gen(function* () {
  const named = process.argv.slice(2);
  const unknown = named.filter((name) => !phaseNames.some((phase) => phase === name));
  if (unknown.length > 0)
    return yield* new Unexpected({
      failures: [`phases ${unknown.join(", ")} to exist; there are ${phaseNames.join(", ")}`]
    });
  const runs = (phase: Phase) => named.length === 0 || named.includes(phase);
  const cryptography = yield* Cryptography.Cryptography;
  const callbacks = yield* host;
  const watched = watching();
  const setting = yield* Config.option(Config.String("BUN_CONFIG_MAX_HTTP_REQUESTS"));
  // The supervisor's count: what this runtime's fetch runs at once.
  const slots = Supervisor.runtimeFetches({
    bun: process.versions.bun,
    setting: setting._tag === "Some" ? setting.value : undefined
  });
  yield* Console.log(
    `Bun ${process.versions.bun ?? "(not Bun)"}, BUN_CONFIG_MAX_HTTP_REQUESTS ${setting._tag === "Some" ? setting.value : "unset"}.`
  );
  // Aggregate residency is not under test: the phases keep several large processes resident.
  const supervisor = yield* Supervisor.make({
    callbackUrls: [callbacks.url],
    standby: true,
    operatingLimits: { "execution.residency.bytes": 8 * 1024 ** 3 }
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, watched.watch(yield* HttpClient.HttpClient)),
    Effect.provideService(WorkerHttp.WorkerHttp, watched.watch(yield* WorkerHttp.WorkerHttp))
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
  const healthy: Array<{ readonly name: string; readonly bound: Bound }> = [];
  const resident = Effect.fnUntraced(function* (name: string, versionId: string) {
    const bound = yield* bind(versionId);
    healthy.push({ name, bound });
    return bound;
  });
  /**
   * Each callback of these calls, by id, arrived at the host once and was answered once, and no
   * other callback of theirs arrived.
   */
  const accounted = (expected: ReadonlyArray<readonly [string, number]>) => {
    const ids = expected.flatMap(([invocationId, count]) =>
      Array.from({ length: count }, (_, sequence) => `${invocationId}#${sequence}`)
    );
    const own = new Set(expected.map(([invocationId]) => invocationId));
    const extra = [...callbacks.received.keys()].filter(
      (id) => own.has(id.split("#")[0]!) && !ids.includes(id)
    );
    const missing = ids.filter((id) => (callbacks.received.get(id) ?? 0) === 0).length;
    const repeated = ids.filter((id) => (callbacks.received.get(id) ?? 0) > 1).length;
    const unanswered = ids.filter((id) => callbacks.answered.get(id) !== 1).length;
    expect(
      missing === 0 && repeated === 0 && unanswered === 0 && extra.length === 0,
      `every callback of ${callsOf(expected.length)} to arrive and be answered once, by id`
    );
    return `Callbacks by id: ${ids.length} expected; ${missing} missing, ${repeated} arrived more than once, ${unanswered} not answered exactly once, ${extra.length} unexpected.`;
  };
  /** The highest resident memory the process reached while `effect` ran, sampled every 50 ms. */
  const peakOf = <A, E, R>(bound: Bound, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const pid = (yield* supervisor.stats({ bindingEpoch: 1 })).processes.find(
        (entry) => entry.processGeneration === bound.processGeneration
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
      const result = yield* effect;
      yield* Effect.sleep(200);
      yield* Fiber.interrupt(sampling);
      return { result, peak };
    });

  const crowd = Effect.gen(function* () {
    // A baseline: the process under test holding a single call.
    const crowded = yield* resident("the crowded process", "ver_crowded");
    watched.probesOf("ver_crowded");
    callbacks.hold();
    const single = yield* call(
      invocation(crowded, callbacks.url, "inv_baseline", "crowd.fanOut", Date.now() + 60_000, {
        callbacks: 1
      })
    ).pipe(Effect.forkChild);
    yield* Effect.sleep(3_000);
    const baseline = watched.probes();
    yield* Console.log(`Baseline, one call held 3000 ms. ${baseline.text}`);
    expect(baseline.within, `every baseline probe to answer within ${probeBound} ms`);
    callbacks.release();
    const baselined = yield* Fiber.join(single);
    expect(
      baselined.ended === "returned" && baselined.ok === 1,
      "the baseline call to return with its callback answered"
    );
    yield* Console.log(`  ${accounted([["inv_baseline", 1]])}`);

    // More callbacks than the slots admit, held past the stall window, and a short call behind.
    yield* Console.log(
      `Crowd: ${crowdCalls} calls of ${callbacksPerCall} callbacks each, ${crowdCalls * callbacksPerCall} callbacks, held ${stall + 2_000} ms.`
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
    watched.probesOf("ver_crowded");
    const ending = yield* watchProcess(supervisor, crowded.processGeneration!, stall + 2_000).pipe(
      Effect.forkChild
    );
    yield* Effect.sleep(1_000);
    const sent = Date.now();
    const short = yield* call(
      invocation(crowded, callbacks.url, "inv_short", "crowd.fanOut", sent + queryDeadline)
    ).pipe(
      Effect.map((end) => ({ end, ms: Date.now() - sent })),
      Effect.forkChild
    );
    const ended = yield* Fiber.join(ending);
    yield* Console.log(
      ended === undefined
        ? "  The process lived."
        : `  The process was ended (${ended.cause}) ${ended.at} ms into the hold.`
    );
    expect(ended === undefined, "the crowded process to live");
    const probes = watched.probes();
    yield* Console.log(`  ${probes.text}`);
    expect(probes.within, `every crowded probe to answer within ${probeBound} ms`);
    const holding = callbacks.held();
    const invoking = watched.invokesInFlight();
    yield* Console.log(
      `  The host was holding ${holding} callbacks, and ${invoking} invokes were in flight: ${holding + invoking} of ${slots} slots.`
    );
    expect(holding + invoking === slots, `the ${slots} slots to be full`);
    callbacks.release();
    const crowdEnded: ReadonlyArray<Called> = yield* Fiber.joinAll(fibers);
    const { end: shortEnd, ms: shortMs } = yield* Fiber.join(short);
    yield* Console.log(
      `  A short call sent behind the crowd, ${queryDeadline} ms deadline, waited its turn: ${shortEnd.ended}, ${shortMs} ms after it was sent.`
    );
    expect(
      shortEnd.ended === "outcome deadline" && shortMs > queryDeadline,
      "the short call to wait for a slot until the crowd was answered, then be answered late"
    );
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
    yield* Console.log(
      `  ${accounted(ids.map((invocationId) => [invocationId, callbacksPerCall] as const))}`
    );
  });

  const wide = Effect.gen(function* () {
    const fanned = yield* resident("the fanning-out process", "ver_fan_out");
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
    yield* Console.log(`  ${accounted([["inv_fan_out", fanOut]])}`);
  });

  const burst = Effect.gen(function* () {
    const bursting = yield* resident("the bursting process", "ver_burst");
    const started = Date.now();
    const deadline = started + burstDeadline;
    const { result: ended, peak } = yield* peakOf(
      bursting,
      Effect.forEach(
        Array.from({ length: burstCalls }, (_, index) => `inv_burst_${index}`),
        (invocationId) =>
          call(
            invocation(bursting, callbacks.url, invocationId, "crowd.burst", deadline, {
              bytes: burstBytes,
              ms: burstMs
            })
          ).pipe(Effect.map((end) => ({ ...end, ms: Date.now() - started }))),
        { concurrency: "unbounded" }
      )
    );
    yield* Console.log(
      `Burst: ${burstCalls} calls at once, each holding ${mib(burstBytes, 3)} for ${burstMs} ms, ${burstDeadline} ms deadline: ${tally(ended.map((end) => end.ended))}; the last ended ${Math.max(...ended.map((end) => end.ms))} ms in; the process peaked at ${mib(peak)}.`
    );
    expect(
      ended.every((end) => end.ended === "returned" && end.ok === 1),
      "every burst call to return"
    );
  });

  const mixed = Effect.gen(function* () {
    const mixing = yield* resident("the mixed-load process", "ver_mixed");
    callbacks.hold();
    const holders = Array.from({ length: 20 }, (_, index) => `inv_holder_${index}`);
    const deadline = Date.now() + 60_000;
    const { result, peak } = yield* peakOf(
      mixing,
      Effect.gen(function* () {
        watched.resetPeak();
        // Twenty calls keep 5 MiB each and hold 8 callbacks each: 180 of the slots.
        const holding = yield* Effect.forEach(holders, (invocationId) =>
          call(
            invocation(mixing, callbacks.url, invocationId, "crowd.fanOut", deadline, {
              callbacks: 8,
              retain: 5 * 1024 ** 2
            })
          ).pipe(
            Effect.forkChild,
            Effect.tap(() => Effect.sleep(25))
          )
        );
        const holdingBy = Date.now() + 10_000;
        while (callbacks.held() < 160 && Date.now() < holdingBy) yield* Effect.sleep(20);
        expect(callbacks.held() === 160, "the twenty calls to hold 160 callbacks");
        // 200 calls of 2 MiB for 1.2 s at once; only the slots left, 76 of 256, run at a time.
        const started = Date.now();
        const bursts = yield* Effect.forEach(
          Array.from({ length: 200 }, (_, index) => `inv_mixed_${index}`),
          (invocationId) =>
            call(
              invocation(mixing, callbacks.url, invocationId, "crowd.burst", deadline, {
                bytes: 2 * 1024 ** 2,
                ms: burstMs
              })
            ),
          { concurrency: "unbounded" }
        );
        const burstMsTaken = Date.now() - started;
        callbacks.release();
        const held: ReadonlyArray<Called> = yield* Fiber.joinAll(holding);
        return { bursts, held, burstMsTaken };
      })
    );
    yield* Console.log(
      `Mixed: 20 calls keeping 100 MiB between them and holding 160 callbacks, then 200 calls each holding 2 MiB for ${burstMs} ms: ${tally([...result.held, ...result.bursts].map((end) => end.ended))}; the 200 took ${result.burstMsTaken} ms; at most ${watched.peakInFlight()} invokes and callbacks were in flight at once; the process peaked at ${mib(peak)}.`
    );
    expect(
      result.bursts.every((end) => end.ended === "returned" && end.ok === 1) &&
        result.held.every((end) => end.ended === "returned" && end.ok === 8 && end.other === 0),
      "all 220 mixed calls to return"
    );
    expect(
      watched.peakInFlight() <= slots,
      `no more than ${slots} invokes and callbacks in flight at once`
    );
    yield* Console.log(`  ${accounted(holders.map((invocationId) => [invocationId, 8] as const))}`);
  });

  const queued = Effect.gen(function* () {
    const busy = yield* resident("the process full of long calls", "ver_queued_busy");
    const quiet = yield* resident("the process with only a queued call", "ver_queued_quiet");
    const long = 5_500;
    const deadline = Date.now() + 60_000;
    // Spaced, so no burst of connections overflows the worker's listen backlog (128 on macOS).
    const fibers = yield* Effect.forEach(
      Array.from({ length: slots }, (_, index) => `inv_long_${index}`),
      (invocationId) =>
        call(
          invocation(busy, callbacks.url, invocationId, "crowd.burst", deadline, {
            bytes: 0,
            ms: long
          })
        ).pipe(
          Effect.forkChild,
          Effect.tap(() => Effect.sleep(2))
        )
    );
    const sent = Date.now();
    const short = yield* call(
      invocation(quiet, callbacks.url, "inv_queued", "crowd.fanOut", sent + queryDeadline)
    );
    const shortMs = Date.now() - sent;
    const longEnded: ReadonlyArray<Called> = yield* Fiber.joinAll(fibers);
    const report = (yield* supervisor.stats({ bindingEpoch: 1 })).reports.find(
      (entry) => entry.processGeneration === quiet.processGeneration
    );
    yield* Console.log(
      `Queued: ${slots} calls of ${long} ms to one process, then a ${queryDeadline} ms call to another: it ended ${short.ended}, ${shortMs} ms after it was sent; the long calls: ${tally(longEnded.map((end) => end.ended))}. ${report === undefined ? "The second process lived." : `The second process was ended (${report.cause}).`}`
    );
    expect(
      short.ended === "outcome deadline" && shortMs >= queryDeadline + 1_000,
      "the queued call to wait past its deadline and a second, then be answered late"
    );
    expect(report === undefined, "the process with only a queued call to live");
    expect(
      longEnded.every((end) => end.ended === "returned"),
      "every long call to return"
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
    expect(
      stalled?.cause === "stall" && stalled.at >= stall && stalled.at < stall + 1_000,
      `the spinning process to be ended for stall within a second of ${stall} ms`
    );
  });

  yield* Effect.gen(function* () {
    if (runs("crowd")) yield* crowd;
    if (runs("fan-out")) yield* wide;
    if (runs("burst")) yield* burst;
    if (runs("mixed")) yield* mixed;
    if (runs("queued")) yield* queued;
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
