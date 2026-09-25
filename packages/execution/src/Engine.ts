// PROTOTYPE for #314: the execution engine as one Effect service.
//
// One workerd process runs the loader Worker (see loader.ts). The engine binds server bundles
// into it by name, invokes `<module>.<export>` with the viewer and arguments, and answers the
// guest's callbacks on a private loopback listener. A callback is admitted only while the
// invocation that minted its capability is live; the capability ends at return or deadline,
// whatever the guest is still doing. Inspection loads a bundle in a throwaway workerd process
// so a non-terminating module initialiser dies with that process, never the serving one.
//
// Not here, by decision on #298/#314: the supervisor watchdog, RSS bounds, process pools and
// Fargate. A CPU-spinning guest is not stopped in this slice; its deadline is a host timeout.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- the engine owns a child process, a temp dir, a port reservation and plain HTTP to workerd on loopback; request bodies to the loader are its own JSON.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type Handlers, handlersOf, isHandlerDescriptor, isHandlerName } from "@patchy/api";
import { sha256 } from "@patchy/core";
import { CONFIG_CAPNP, LOADER_SOURCE } from "./loader.js";

export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()(
  "EngineUnavailable",
  {
    stage: Schema.Literals(["spawn", "bind", "invoke", "inspect", "bundle"]),
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return `The execution engine is unavailable at ${this.stage}${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class InvocationTimeout extends Schema.TaggedError<InvocationTimeout>()(
  "InvocationTimeout",
  { deadlineMs: Schema.Int }
) {
  override get message() {
    return `The handler did not return within ${this.deadlineMs} ms.`;
  }
}

/** Discovery could not derive a handler map; `reason` is safe to show the publisher. */
export class InspectionFailed extends Schema.TaggedError<InspectionFailed>()("InspectionFailed", {
  reason: Schema.String
}) {
  override get message() {
    return `The server bundle could not be inspected: ${this.reason}`;
  }
}

/** What a refused callback answers the guest; the guest sees the code, never the cause. */
export interface CallbackRefusal {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface Invocation {
  /** The bundle's name inside workerd; a new digest is a new name. */
  readonly name: string;
  /** Supplied on `bundle_required` only: the exact bytes the version recorded. */
  readonly bundle: Effect.Effect<string, EngineUnavailable>;
  readonly handler: string;
  readonly args: unknown;
  readonly viewer: unknown;
  readonly deadlineMs: number;
  readonly callback: (op: string, args: unknown) => Effect.Effect<unknown, CallbackRefusal>;
}

const LogLine = Schema.Struct({
  message: Schema.String,
  details: Schema.optionalKey(Schema.Json)
});
export type LogLine = typeof LogLine.Type;
const logField = { log: Schema.optionalKey(Schema.Array(LogLine)) };
export const GuestReply = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.optionalKey(Schema.Json),
    guestMs: Schema.optionalKey(Schema.Number),
    firstLoad: Schema.optionalKey(Schema.Boolean),
    ...logField
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literal("handler"),
    code: Schema.String,
    details: Schema.optionalKey(Schema.Json),
    ...logField
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literal("refused"),
    code: Schema.String,
    message: Schema.optionalKey(Schema.String),
    details: Schema.optionalKey(Schema.Json),
    ...logField
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literals(["failed", "not_a_handler", "no_such_handler", "bundle_required"]),
    message: Schema.optionalKey(Schema.String),
    stack: Schema.optionalKey(Schema.String),
    export: Schema.optionalKey(Schema.String),
    ...logField
  })
]);
export type GuestReply = typeof GuestReply.Type;
const decodeReply = Schema.decodeUnknownEffect(GuestReply);
const InspectReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), handlers: Schema.Record(Schema.String, Schema.Json) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
    message: Schema.optionalKey(Schema.String),
    export: Schema.optionalKey(Schema.String)
  })
]);
const decodeInspect = Schema.decodeUnknownEffect(InspectReply);
const OutboundAttempt = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  at: Schema.Number
});
const decodeAttempts = Schema.decodeUnknownEffect(Schema.Array(OutboundAttempt));

export class Engine extends Context.Service<
  Engine,
  {
    /** Loads a bundle under its name and forces the isolate up; idempotent per name. */
    readonly bind: (
      name: string,
      bundle: string
    ) => Effect.Effect<{ readonly bindMs: number; readonly loadMs: number }, EngineUnavailable>;
    readonly invoke: (
      input: Invocation
    ) => Effect.Effect<GuestReply, EngineUnavailable | InvocationTimeout>;
    /** Derives the handler map from a bundle in a throwaway process; no capabilities. */
    readonly inspect: (
      bundle: string,
      options?: { readonly timeoutMs?: number }
    ) => Effect.Effect<Handlers, InspectionFailed | EngineUnavailable>;
    /** What guests tried to reach through global fetch; for the smoke, not a product surface. */
    readonly outboundAttempts: Effect.Effect<
      ReadonlyArray<typeof OutboundAttempt.Type>,
      EngineUnavailable
    >;
    readonly spawnMs: number;
    readonly callbackOrigin: string;
  }
>()("@patchy/execution/Engine") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      server.close(() => resolve(address.port));
    });
  });

/** Plain HTTP to the loader on loopback; a request is aborted when its fiber is interrupted. */
const post = (stage: EngineUnavailable["stage"], url: string, body: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    catch: (cause) => new EngineUnavailable({ stage, cause })
  });

interface Process {
  readonly url: string;
  readonly child: ChildProcess;
  readonly spawnMs: number;
}

/** A workerd process running the loader, alive for the scope; SIGKILL and cleanup on release. */
const spawnWorkerd = Effect.fn("Engine.spawnWorkerd")(function* (binary: string) {
  const started = yield* Clock.currentTimeMillis;
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "patchy-engine-")),
      catch: (cause) => new EngineUnavailable({ stage: "spawn", cause })
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
  );
  yield* Effect.tryPromise({
    try: async () => {
      await writeFile(join(dir, "loader.js"), LOADER_SOURCE);
      await writeFile(join(dir, "config.capnp"), CONFIG_CAPNP);
    },
    catch: (cause) => new EngineUnavailable({ stage: "spawn", cause })
  });
  const port = yield* Effect.tryPromise({
    try: reservePort,
    catch: (cause) => new EngineUnavailable({ stage: "spawn", cause })
  });
  const stderr: string[] = [];
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(
        binary,
        [
          "serve",
          join(dir, "config.capnp"),
          "--experimental",
          `--socket-addr=http=127.0.0.1:${port}`
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr.push(chunk);
        if (stderr.length > 50) stderr.shift();
      });
      return child;
    }),
    (child) => Effect.sync(() => child.kill("SIGKILL"))
  );
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null)
      return yield* new EngineUnavailable({
        stage: "spawn",
        detail: `workerd exited with ${child.exitCode}: ${stderr.join("").slice(-500)}`
      });
    const healthy = yield* Effect.tryPromise({
      try: async () => (await fetch(`${url}/healthz`)).ok,
      catch: () => new EngineUnavailable({ stage: "spawn" })
    }).pipe(Effect.orElseSucceed(() => false));
    if (healthy) break;
    if (attempt > 1500)
      return yield* new EngineUnavailable({
        stage: "spawn",
        detail: "workerd never became healthy"
      });
    yield* Effect.sleep("10 millis");
  }
  const spawnMs = (yield* Clock.currentTimeMillis) - started;
  return { url, child, spawnMs } satisfies Process;
});

const inspectIn = Effect.fn("Engine.inspectIn")(function* (
  process: Process,
  bundle: string,
  timeoutMs: number
) {
  const name = `inspect:${sha256(bundle)}`;
  const response = yield* post("inspect", `${process.url}/inspect`, { name, bundle }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new InspectionFailed({
            reason: `the bundle did not finish loading within ${timeoutMs} ms (a module initialiser that never returns?)`
          })
        )
    })
  );
  const reply = yield* decodeInspect(response.body).pipe(
    Effect.mapError(
      () => new InspectionFailed({ reason: "the loader answered with an unexpected shape" })
    )
  );
  if (!reply.ok)
    return yield* new InspectionFailed({
      reason:
        reply.error === "not_a_handler"
          ? `server/ export ${reply.export ?? "?"} is not a handler; every export of a server module must be a query, mutation or action`
          : (reply.message ?? reply.error)
    });
  for (const [handler, descriptor] of Object.entries(reply.handlers)) {
    if (!isHandlerName(handler) || !isHandlerDescriptor(descriptor))
      return yield* new InspectionFailed({
        reason: `handler ${handler} has an invalid declaration; args must be t.object({...}) and result a t descriptor`
      });
  }
  const handlers: Handlers = handlersOf(reply.handlers);
  return handlers;
});

/** Discovery without a serving engine: a throwaway process per call, killed with its scope. */
export const inspectBundle = (binary: string, bundle: string, timeoutMs = 5_000) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* spawnWorkerd(binary);
      return yield* inspectIn(process, bundle, timeoutMs);
    })
  );

export const make = (options: { readonly binary: string }) =>
  Effect.gen(function* () {
    const serving = yield* spawnWorkerd(options.binary);
    const registry = new Map<string, Invocation["callback"]>();

    // The callback listener: loopback only, capability as bearer, nothing administrative.
    const listener = HttpRouter.use((router) =>
      router.add(
        "POST",
        "/callback",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization ?? "";
          const capability = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
          const callback = registry.get(capability);
          if (callback === undefined)
            return HttpServerResponse.jsonUnsafe(
              {
                ok: false,
                code: "capability_refused",
                message: "No live invocation holds this capability."
              },
              { status: 403 }
            );
          const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
          if (!isRecord(body) || typeof body.op !== "string")
            return HttpServerResponse.jsonUnsafe(
              { ok: false, code: "invalid_request", message: "Malformed callback." },
              { status: 400 }
            );
          const outcome = yield* Effect.exit(callback(body.op, body.args));
          if (Exit.isSuccess(outcome))
            return HttpServerResponse.jsonUnsafe({ ok: true, result: outcome.value ?? null });
          const refusal = Cause.findErrorOption(outcome.cause);
          return Option.isSome(refusal)
            ? HttpServerResponse.jsonUnsafe(
                {
                  ok: false,
                  code: refusal.value.code,
                  message: refusal.value.message,
                  ...(refusal.value.details === undefined ? {} : { details: refusal.value.details })
                },
                { status: 400 }
              )
            : HttpServerResponse.jsonUnsafe(
                { ok: false, code: "source_unavailable", message: "The callback failed." },
                { status: 503 }
              );
        })
      )
    );
    const serverContext = yield* Layer.build(
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
    );
    yield* Layer.build(
      HttpRouter.serve(listener, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(Layer.succeedContext(serverContext))
      )
    );
    const callbackOrigin = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(
      Effect.provideContext(serverContext)
    );

    const bind = Effect.fn("Engine.bind")(function* (name: string, bundle: string) {
      const started = yield* Clock.currentTimeMillis;
      const response = yield* post("bind", `${serving.url}/bind`, { name, bundle });
      if (response.status !== 200 || !isRecord(response.body) || response.body.ok !== true)
        return yield* new EngineUnavailable({
          stage: "bind",
          detail: isRecord(response.body)
            ? String(response.body.message ?? response.body.error)
            : ""
        });
      return {
        bindMs: (yield* Clock.currentTimeMillis) - started,
        loadMs: typeof response.body.loadMs === "number" ? response.body.loadMs : 0
      };
    });

    const invoke = Effect.fn("Engine.invoke")(function* (input: Invocation) {
      const capability = `cap_${randomBytes(18).toString("base64url")}`;
      const invocationId = `inv_${randomBytes(9).toString("hex")}`;
      registry.set(capability, input.callback);
      const send = (bundle?: string) =>
        post("invoke", `${serving.url}/invoke`, {
          name: input.name,
          ...(bundle === undefined ? {} : { bundle }),
          invocationId,
          capability,
          hostUrl: callbackOrigin,
          handler: input.handler,
          args: input.args,
          viewer: input.viewer
        });
      return yield* Effect.gen(function* () {
        let response = yield* send();
        if (response.status === 409) response = yield* send(yield* input.bundle);
        return yield* decodeReply(response.body).pipe(
          Effect.mapError(
            (cause) => new EngineUnavailable({ stage: "invoke", detail: "unexpected reply", cause })
          )
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: input.deadlineMs,
          orElse: () => Effect.fail(new InvocationTimeout({ deadlineMs: input.deadlineMs }))
        }),
        // The capability ends here whatever the guest is still doing; a late callback is refused.
        Effect.ensuring(Effect.sync(() => registry.delete(capability)))
      );
    });

    const inspect: Engine["Service"]["inspect"] = (bundle, inspectOptions) =>
      inspectBundle(options.binary, bundle, inspectOptions?.timeoutMs ?? 5_000);

    const outboundAttempts = Effect.gen(function* () {
      const attempts = yield* Effect.tryPromise({
        try: async () => (await fetch(`${serving.url}/outbound-attempts`)).json(),
        catch: (cause) => new EngineUnavailable({ stage: "invoke", cause })
      });
      return yield* decodeAttempts(attempts).pipe(
        Effect.mapError((cause) => new EngineUnavailable({ stage: "invoke", cause }))
      );
    });

    return Engine.of({
      bind,
      invoke,
      inspect,
      outboundAttempts,
      spawnMs: serving.spawnMs,
      callbackOrigin
    });
  });

export const layer = (options: { readonly binary: string }) => Layer.effect(Engine, make(options));
