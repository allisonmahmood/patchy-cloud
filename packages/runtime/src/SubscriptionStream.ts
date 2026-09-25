// PROTOTYPE for #314 round 3: #313's subscription stream (PR #343) lifted onto tier 2 queries.
// @effect-diagnostics preferSchemaOverJson:off
// JSON.stringify is the change detector (serialised result compare) and the SSE framer here.
// One SSE stream per open document. A subscription is a tier 2 query (`server.call` naming a
// query handler); the server re-runs it through Runtime.call under the stream's own request (so
// it re-admits as the subscriber by construction) whenever a table its last run touched is
// written, or the dev loop rebinds the bundle, and delivers the whole reply only when it
// changed. Dependencies are traced per run by ServerCall (`Invalidation.Subscribed`); a wake
// that lands while a run is in flight is kept and re-checked against the new dependencies, so
// a commit racing the first run is never lost. Subscription state is in memory only.
//
// Wire (each SSE frame is `data: <json>\n\n`):
//   {type:"hello", streamId, viewer}
//   {type:"must-resync"}                       first frame on a stream opened with resume:true
//   {type:"snapshot", id, revision, dependencies, value}   value is the server.call reply
//   {type:"up-to-date", id}                    after a subscription's first snapshot
//   {type:"error", id, code, error}            that subscription ends; the stream continues
//   {type:"stop", code}                        the stream ends; the shell shows the notice
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { runtimeOperations, type RuntimeEnvelope } from "@patchy/api";
import { newInternalId } from "@patchy/core";
import * as Invalidation from "./Invalidation.js";
import * as Runtime from "./Runtime.js";
import { failure } from "./RuntimeApi.js";

/** Trailing debounce after a wake, and the longest a continuous burst may postpone a re-run. */
const DEBOUNCE_MS = 25;
const MAX_WAIT_MS = 250;
/**
 * Re-runs in flight across the whole process. #313 decided a per-company semaphore plus a
 * per-patch cap; one process-wide four here matches the company's four invocation slots.
 */
const RERUN_CONCURRENCY = 4;
/** A transient failure is a late re-run, never a lost subscription. */
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 2000;
const transientCodes = new Set(["busy", "rate_limited", "source_unavailable", "timeout"]);

const SubscriptionRequest = Schema.Struct({
  id: Schema.String,
  op: Schema.String,
  args: Schema.Unknown
});
const envelopeFields = {
  patchId: Schema.String,
  versionId: Schema.String,
  principal: Schema.Unknown,
  wire: Schema.Int
};
const OpenBody = Schema.Struct({
  ...envelopeFields,
  resume: Schema.Boolean,
  subscriptions: Schema.Array(SubscriptionRequest)
});
const UpdateBody = Schema.Struct({
  ...envelopeFields,
  add: Schema.Array(SubscriptionRequest),
  remove: Schema.Array(Schema.String)
});
const decodeOpen = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenBody), {
  onExcessProperty: "error"
});
const decodeUpdate = Schema.decodeUnknownEffect(Schema.fromJsonString(UpdateBody), {
  onExcessProperty: "error"
});
const isMe = Schema.is(runtimeOperations.me.response);

type Command =
  | { readonly type: "add"; readonly subscriptions: ReadonlyArray<typeof SubscriptionRequest.Type> }
  | { readonly type: "remove"; readonly ids: ReadonlyArray<string> }
  | { readonly type: "wake"; readonly keys: ReadonlyArray<string> };

interface Subscription {
  readonly id: string;
  readonly envelope: typeof RuntimeEnvelope.Type;
  /** What the last run read, plus the version key; replaced after every successful run. */
  dependencies: ReadonlySet<string>;
  /** Wakes that arrived while a run was in flight; re-checked against its new dependencies. */
  readonly wokenDuringRun: Set<string>;
  revision: number;
  last: string | undefined;
  dirty: boolean;
  running: boolean;
  timer: Fiber.Fiber<void> | undefined;
  firstWakeAt: number | undefined;
}

interface StreamState {
  readonly id: string;
  readonly viewer: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly commands: Queue.Queue<Command>;
  readonly subscriptions: Map<string, Subscription>;
}

/** Module state: one replica, one process. Stats are per patch for the Playwright report. */
const streams = new Map<string, StreamState>();
const stats = new Map<
  string,
  { reruns: number; deliveries: number; suppressed: number; retries: number; wakes: number }
>();
const statsFor = (patchId: string) => {
  let entry = stats.get(patchId);
  if (entry === undefined) {
    entry = { reruns: 0, deliveries: 0, suppressed: 0, retries: 0, wakes: 0 };
    stats.set(patchId, entry);
  }
  return entry;
};

const stoppingCodes = new Set([
  "session_expired",
  "principal_changed",
  "access_denied",
  "not_available_on_public",
  "shell_outdated"
]);

/** Only a tier 2 query may be subscribed; the handler's kind is checked by ServerCall per run. */
const refusalOf = (op: string, args: unknown): string | undefined => {
  if (op !== "server.call")
    return `Operation ${op} cannot be subscribed here; subscribe to a tier 2 query with patchy.server.<module>.<query>.subscribe.`;
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return typeof record.handler === "string" ? undefined : "A subscription names its handler.";
};

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const reruns = yield* Semaphore.make(RERUN_CONCURRENCY);

    /** Admission for open and update: the session and principal of this request, as `me`. */
    const admit = Effect.fn("PrototypeStreamApi.admit")(function* (
      body: typeof OpenBody.Type | typeof UpdateBody.Type
    ) {
      const me = yield* runtime.call({
        patchId: body.patchId,
        versionId: body.versionId,
        principal: body.principal,
        wire: body.wire,
        op: "me",
        args: {}
      });
      if (!isMe(me) || me === null) return yield* new Runtime.AccessDenied({});
      return me;
    });

    const refuse = (subscriptions: ReadonlyArray<typeof SubscriptionRequest.Type>) => {
      for (const subscription of subscriptions) {
        const refusal = refusalOf(subscription.op, subscription.args);
        if (refusal !== undefined)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, code: "invalid_request", error: refusal },
            { status: 400, headers: { "cache-control": "no-store" } }
          );
      }
      return undefined;
    };

    const open = Effect.fn("PrototypeStreamApi.open")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const body = yield* decodeOpen(text).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const me = yield* admit(body);
      const refused = refuse(body.subscriptions);
      if (refused !== undefined) return refused;
      const state: StreamState = {
        id: newInternalId("stream"),
        viewer: me.user.id,
        patchId: body.patchId,
        versionId: body.versionId,
        commands: yield* Queue.make<Command>(),
        subscriptions: new Map()
      };
      const envelope = (
        subscription: typeof SubscriptionRequest.Type
      ): typeof RuntimeEnvelope.Type => ({
        patchId: body.patchId,
        versionId: body.versionId,
        principal: body.principal,
        wire: body.wire,
        op: subscription.op,
        args: subscription.args
      });
      const counters = statsFor(body.patchId);

      const engine = Effect.gen(function* () {
        const out = yield* Queue.make<string, Cause.Done>();
        const emit = (event: unknown) => Queue.offer(out, sse(event));
        streams.set(state.id, state);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            streams.delete(state.id);
          })
        );
        const unsubscribe = yield* Invalidation.subscribe((keys) =>
          Effect.asVoid(Queue.offer(state.commands, { type: "wake", keys }))
        );
        yield* Effect.addFinalizer(() => unsubscribe);

        const stop = (code: string) =>
          Effect.gen(function* () {
            yield* emit({ type: "stop", code });
            yield* Queue.end(out);
          });

        /** One re-run in flight per subscription; loops while wakes keep arriving. */
        const runOnce = (subscription: Subscription) =>
          Effect.gen(function* () {
            if (subscription.running) return;
            subscription.running = true;
            let attempt = 0;
            try {
              while (
                subscription.dirty &&
                state.subscriptions.get(subscription.id) === subscription
              ) {
                subscription.dirty = false;
                subscription.firstWakeAt = undefined;
                subscription.wokenDuringRun.clear();
                const traced = { dependencies: new Set<string>() };
                const result = yield* Effect.exit(
                  reruns.withPermits(1)(
                    runtime
                      .call(subscription.envelope)
                      .pipe(Effect.provideService(Invalidation.Subscribed, traced))
                  )
                );
                counters.reruns += 1;
                if (Exit.isSuccess(result)) {
                  traced.dependencies.add(Invalidation.versionKey(state.patchId));
                  subscription.dependencies = traced.dependencies;
                  for (const key of subscription.wokenDuringRun)
                    if (traced.dependencies.has(key)) subscription.dirty = true;
                  subscription.wokenDuringRun.clear();
                  const serialised = JSON.stringify(result.value);
                  if (serialised === subscription.last) {
                    counters.suppressed += 1;
                    continue;
                  }
                  const first = subscription.last === undefined;
                  subscription.last = serialised;
                  subscription.revision += 1;
                  counters.deliveries += 1;
                  yield* emit({
                    type: "snapshot",
                    id: subscription.id,
                    revision: subscription.revision,
                    dependencies: [...traced.dependencies],
                    value: result.value
                  });
                  if (first) yield* emit({ type: "up-to-date", id: subscription.id });
                  continue;
                }
                if (Cause.hasInterrupts(result.cause)) return;
                const error = Cause.findErrorOption(result.cause);
                const code = Option.isSome(error) ? error.value.code : "source_unavailable";
                if (stoppingCodes.has(code)) {
                  yield* stop(code);
                  return;
                }
                if (transientCodes.has(code)) {
                  counters.retries += 1;
                  subscription.dirty = true;
                  yield* Effect.sleep(Math.min(RETRY_BASE_MS * 2 ** attempt++, RETRY_MAX_MS));
                  continue;
                }
                state.subscriptions.delete(subscription.id);
                yield* emit({
                  type: "error",
                  id: subscription.id,
                  code,
                  error: Option.isSome(error) ? error.value.message : "Runtime request failed."
                });
              }
            } finally {
              subscription.running = false;
            }
          });

        /** Trailing debounce with a ceiling, so a continuous burst still shows progress. */
        const schedule = (subscription: Subscription, now: number) =>
          Effect.gen(function* () {
            subscription.dirty = true;
            subscription.firstWakeAt ??= now;
            const waited = now - subscription.firstWakeAt;
            if (subscription.timer !== undefined) {
              if (waited >= MAX_WAIT_MS) return;
              yield* Fiber.interrupt(subscription.timer);
            }
            subscription.timer = yield* Effect.forkScoped(
              Effect.gen(function* () {
                yield* Effect.sleep(Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - waited)));
                subscription.timer = undefined;
                yield* runOnce(subscription);
              })
            );
          });

        const loop = Effect.gen(function* () {
          while (true) {
            const command = yield* Queue.take(state.commands);
            if (command.type === "add") {
              for (const request of command.subscriptions) {
                if (state.subscriptions.has(request.id)) continue;
                if (refusalOf(request.op, request.args) !== undefined) continue; // refused before it reached the queue
                const subscription: Subscription = {
                  id: request.id,
                  envelope: envelope(request),
                  dependencies: new Set([Invalidation.versionKey(body.patchId)]),
                  wokenDuringRun: new Set(),
                  revision: 0,
                  last: undefined,
                  dirty: true,
                  running: false,
                  timer: undefined,
                  firstWakeAt: undefined
                };
                state.subscriptions.set(request.id, subscription);
                // The listener is already registered, so a commit racing this first run
                // either lands in the snapshot or arrives as a wake that re-runs it.
                yield* Effect.forkScoped(runOnce(subscription));
              }
            } else if (command.type === "remove") {
              for (const id of command.ids) {
                const subscription = state.subscriptions.get(id);
                if (subscription === undefined) continue;
                state.subscriptions.delete(id);
                if (subscription.timer !== undefined) yield* Fiber.interrupt(subscription.timer);
              }
            } else {
              const now = yield* Clock.currentTimeMillis;
              for (const subscription of state.subscriptions.values()) {
                if (subscription.running)
                  for (const key of command.keys) subscription.wokenDuringRun.add(key);
                if (command.keys.some((key) => subscription.dependencies.has(key))) {
                  counters.wakes += 1;
                  yield* schedule(subscription, now);
                }
              }
            }
          }
        });

        yield* emit({ type: "hello", streamId: state.id, viewer: me.user.id });
        // Continuity across a drop cannot be proven with in-memory state: say so, then resnapshot.
        if (body.resume) yield* emit({ type: "must-resync" });
        yield* Queue.offer(state.commands, { type: "add", subscriptions: body.subscriptions });
        yield* Effect.forkScoped(loop);
        return Stream.fromQueue(out);
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));

      return HttpServerResponse.stream(Stream.unwrap(engine).pipe(Stream.encodeText), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no"
        }
      });
    });

    const update = Effect.fn("PrototypeStreamApi.update")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const state = streams.get(params.streamId ?? "");
      if (state === undefined)
        return HttpServerResponse.jsonUnsafe(
          { ok: false, code: "invalid_request", error: "Unknown stream." },
          { status: 404, headers: { "cache-control": "no-store" } }
        );
      const text = yield* request.text.pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const body = yield* decodeUpdate(text).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const me = yield* admit(body);
      if (
        me.user.id !== state.viewer ||
        body.patchId !== state.patchId ||
        body.versionId !== state.versionId
      )
        return yield* new Runtime.AccessDenied({});
      const refused = refuse(body.add);
      if (refused !== undefined) return refused;
      if (body.remove.length > 0)
        yield* Queue.offer(state.commands, { type: "remove", ids: body.remove });
      if (body.add.length > 0)
        yield* Queue.offer(state.commands, { type: "add", subscriptions: body.add });
      return HttpServerResponse.jsonUnsafe(
        { ok: true, value: null },
        { headers: { "cache-control": "no-store" } }
      );
    });

    const report = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const patchId = new URL(request.url, "http://localhost").searchParams.get("patchId") ?? "";
      const counters = statsFor(patchId);
      let subscriptions = 0;
      let open = 0;
      for (const state of streams.values()) {
        if (state.patchId !== patchId) continue;
        open += 1;
        subscriptions += state.subscriptions.size;
      }
      return HttpServerResponse.jsonUnsafe(
        { ...counters, busWakes: Invalidation.wakeCount(), streams: open, subscriptions },
        { headers: { "cache-control": "no-store" } }
      );
    });

    yield* router.add("POST", "/api/runtime/prototype/stream", () =>
      open().pipe(Effect.catch((error) => Effect.succeed(failure(error))))
    );
    yield* router.add("POST", "/api/runtime/prototype/stream/:streamId", () =>
      update().pipe(Effect.catch((error) => Effect.succeed(failure(error))))
    );
    yield* router.add("GET", "/api/runtime/prototype/stats", report);
  })
);
