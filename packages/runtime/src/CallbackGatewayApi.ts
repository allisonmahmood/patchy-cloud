// @effect-diagnostics nodeBuiltinImport:off -- Node owns the private HTTP listener.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { isIP } from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { closeAfterAnswer, limitRefusal, RuntimeFailure } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as CallbackGateway from "./CallbackGateway.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";

export class ListenerRefused extends Schema.TaggedError<ListenerRefused>()(
  "CallbackListenerRefused",
  {
    reason: Schema.Literals(["public_interface", "invalid_port"])
  }
) {
  override get message() {
    return `Callback listener refused: ${this.reason}.`;
  }
}
export class ListenerUnavailable extends Schema.TaggedError<ListenerUnavailable>()(
  "CallbackListenerUnavailable",
  {
    host: Schema.String,
    port: Schema.Int,
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `Callback listener could not listen on ${this.host}:${this.port}.`;
  }
}
class MalformedCallback extends Schema.TaggedError<MalformedCallback>()("MalformedCallback", {
  cause: Schema.Defect()
}) {
  override get message() {
    return "Malformed callback request.";
  }
}
class CallbackFileTooLarge extends Schema.TaggedError<CallbackFileTooLarge>()(
  "CallbackFileTooLarge",
  {
    maxBytes: Schema.Number
  }
) {
  override get message() {
    return "The callback file body exceeds its byte limit.";
  }
}
/** A marked model call's arguments past `models.ingress.bytes`, refused as they are read. */
class ModelCallTooLarge extends Schema.TaggedError<ModelCallTooLarge>()("ModelCallTooLarge", {}) {
  override get message() {
    return GuestProtocol.modelIngressTooLarge.error;
  }
}
class CallbackBudgetExceeded extends Schema.TaggedError<CallbackBudgetExceeded>()(
  "CallbackBudgetExceeded",
  {
    failure: RuntimeFailure
  }
) {
  override get message() {
    return this.failure.error;
  }
}
export interface Options {
  readonly host?: string;
  readonly port?: number;
  /** Deployment must restrict this private interface to the execution security group. */
  readonly privateInterface?: boolean;
}
const strict = { onExcessProperty: "error" } as const;
const JsonCallback = Schema.Struct({
  op: GuestProtocol.Callback.fields.op,
  args: GuestProtocol.Callback.fields.args
});
const decodeCallback = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonCallback), strict);
const decodeIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({
    invocationId: GuestProtocol.Attempt.fields.invocationId,
    attemptId: GuestProtocol.Attempt.fields.attemptId,
    processGeneration: Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0)
    )
  }),
  strict
);
const validPort = Schema.is(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })));
const privateHost = (host: string, explicit: boolean) => {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 127 ||
      (explicit &&
        (octets[0] === 10 ||
          (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
          (octets[0] === 192 && octets[1] === 168)))
    );
  }
  if (family !== 6) return false;
  const normalized = new URL(`http://[${host}]/`).hostname;
  return normalized === "[::1]" || (explicit && /^\[f[cd][0-9a-f]{2}:/i.test(normalized));
};
const json = (reply: GuestProtocol.CallbackReply) =>
  HttpServerResponse.jsonUnsafe(reply, { headers: { "cache-control": "no-store" } });
const isModelCall = (op: string | undefined): op is "models.decide" | "models.generate" =>
  op === "models.decide" || op === "models.generate";
/** A refusal given before the capability is known: a model call's says nothing was sent. */
const said = (modelCall: string | undefined, failure: RuntimeFailure): RuntimeFailure =>
  modelCall === undefined ? failure : { ...failure, details: { ...failure.details, sent: false } };
const invalid: RuntimeFailure = {
  ok: false,
  source: "patchy",
  code: "invalid_request",
  error: "Malformed callback request."
};

/** Builds only the private callback handler, never a route on the public HttpApi. */
export const make = Effect.gen(function* () {
  const gateway = yield* CallbackGateway.CallbackGateway;
  const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
  const byteLimit = yield* ContractLimits.get("tier2.callbacks.bytes");
  const fileLimit = yield* ContractLimits.get("tier2.callbacks.fileBytes");
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Classified before anything can refuse it, so a model call's every refusal before its
    // handler says nothing was sent. The mark is the execution task's, checked against the call
    // once it is read.
    const marked = request.headers["x-patchy-model-call"];
    const modelCall = isModelCall(marked) ? marked : undefined;
    /**
     * An answer given before the body is read. A model call's connection closes after it, so its
     * arguments, up to a mebibyte still arriving or never sent, are neither drained nor waited
     * for; an ordinary callback's stays open for the loader's next, as it always has.
     */
    const unread = (reply: GuestProtocol.CallbackReply) =>
      modelCall === undefined
        ? Effect.succeed(json(reply))
        : Effect.as(closeAfterAnswer, json(reply));
    if (request.method !== "POST" || request.url.split("?")[0] !== "/callback")
      return yield* unread(said(modelCall, invalid));
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer "))
      return yield* unread(
        said(modelCall, {
          ok: false,
          source: "patchy",
          code: "access_denied",
          error: "An invocation capability is required."
        })
      );
    const token = authorization.slice(7);
    const identity = yield* Effect.result(
      decodeIdentity({
        invocationId: request.headers["x-patchy-invocation-id"],
        attemptId: request.headers["x-patchy-attempt-id"],
        processGeneration: request.headers["x-patchy-process-generation"]
      })
    );
    if (identity._tag === "Failure") return yield* unread(said(modelCall, invalid));
    const resolved = yield* Effect.result(capabilities.resolve(token, identity.success));
    if (resolved._tag === "Failure")
      return yield* unread(said(modelCall, resolved.failure.failure));
    const capability = resolved.success;
    // A marked call's refusals are kept once, said unsent, by the gateway; others as they were.
    const stored = modelCall === undefined;
    const refuse = (failure: RuntimeFailure, status: number) =>
      modelCall === undefined
        ? Effect.succeed(capabilities.rememberRefusal(capability, failure, status))
        : gateway.refuseModelCall(capability, modelCall, failure, status);
    const countRefusal = capabilities.chargeCallback(capability, { stored });
    if (countRefusal !== undefined)
      return yield* unread(
        modelCall === undefined
          ? countRefusal
          : yield* gateway.refuseModelCall(capability, modelCall, countRefusal, 429)
      );
    // A marked call is counted as one of its action's model call attempts and takes one of its
    // places for running ones before it is read, so a fifth is refused before it costs a read,
    // and one refused here still counts toward the action's attempts.
    const admission =
      modelCall === undefined ? undefined : yield* gateway.admitModelCall(capability, modelCall);
    if (admission !== undefined && "refused" in admission) return yield* unread(admission.refused);
    const place = admission?.place;
    const raw = request.headers["x-patchy-callback"];
    const available = Math.max(0, byteLimit - capability.tree.bytes);
    // A marked call is read no further than a model call's arguments may go.
    const modelCap = modelCall === undefined ? Infinity : GuestProtocol.modelIngressLimit.value;
    const maxBytes = Math.min(
      raw === undefined ? available : Math.min(fileLimit, available),
      modelCap
    );
    const overflow = (bytes: number) =>
      modelCap <= available && maxBytes === modelCap
        ? new ModelCallTooLarge()
        : raw !== undefined && fileLimit <= available
          ? new CallbackFileTooLarge({ maxBytes: fileLimit })
          : new CallbackBudgetExceeded({
              failure: capabilities.chargeBytes(capability, bytes, { stored })!
            });
    const reply = yield* capabilities
      .execute(
        capability,
        Effect.gen(function* () {
          if (raw !== undefined) {
            const metadataBytes = Buffer.byteLength(raw);
            const failure = capabilities.chargeBytes(capability, metadataBytes, { stored });
            if (failure !== undefined) {
              yield* closeAfterAnswer;
              return yield* new CallbackBudgetExceeded({ failure });
            }
          }
          const length = Number(request.headers["content-length"]);
          if (raw !== undefined && Number.isFinite(length))
            capability.counters.peakFileBytes = Math.max(capability.counters.peakFileBytes, length);
          if (length > maxBytes) {
            yield* closeAfterAnswer;
            return yield* overflow(length);
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          // A size refusal stops the read and closes the connection after its answer, rather than
          // leaving Effect's server reading the unread rest.
          const pull = yield* Stream.toPull(request.stream);
          while (true) {
            const batch = yield* pull.pipe(
              Pull.catchDone(() => Effect.void),
              Effect.mapError((cause) => new MalformedCallback({ cause }))
            );
            if (batch === undefined) break;
            for (const chunk of batch) {
              size += chunk.byteLength;
              if (raw !== undefined)
                capability.counters.peakFileBytes = Math.max(
                  capability.counters.peakFileBytes,
                  size
                );
              if (size > maxBytes) {
                yield* closeAfterAnswer;
                return yield* overflow(chunk.byteLength);
              }
              const failure = capabilities.chargeBytes(capability, chunk.byteLength, { stored });
              if (failure !== undefined) {
                yield* closeAfterAnswer;
                return yield* new CallbackBudgetExceeded({ failure });
              }
              chunks.push(chunk);
            }
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text =
            raw === undefined
              ? new TextDecoder().decode(bytes)
              : yield* Effect.try({
                  try: () => decodeURIComponent(raw),
                  catch: (cause) => new MalformedCallback({ cause })
                });
          const input = yield* decodeCallback(text).pipe(
            Effect.mapError((cause) => new MalformedCallback({ cause }))
          );
          const callback: GuestProtocol.Callback =
            raw === undefined
              ? input
              : {
                  ...input,
                  body: {
                    bytes,
                    contentType: request.headers["content-type"] ?? "application/octet-stream"
                  }
                };
          return callback;
        })
      )
      .pipe(
        Effect.flatMap((callback) =>
          gateway.callback(token, identity.success, callback, {
            modelCall: marked,
            ...(place === undefined ? {} : { place })
          })
        ),
        Effect.catchTags({
          CapabilityRefused: (error) => refuse(error.failure, 403),
          MalformedCallback: () => refuse(invalid, 400),
          ModelCallTooLarge: () => refuse(GuestProtocol.modelIngressTooLarge, 413),
          CallbackFileTooLarge: (error) =>
            refuse(
              {
                ok: false,
                source: "patchy",
                error: error.message,
                ...limitRefusal("tier2.callbacks.fileBytes", error.maxBytes)
              },
              413
            ),
          CallbackBudgetExceeded: (error) =>
            modelCall === undefined
              ? Effect.succeed(error.failure)
              : gateway.refuseModelCall(capability, modelCall, error.failure, 429)
        }),
        // The place goes back with the request unless the call's work took it over.
        Effect.ensuring(Effect.sync(() => place?.release()))
      );
    if (reply.ok && "body" in reply)
      return HttpServerResponse.uint8Array(reply.body.bytes, {
        contentType: reply.body.contentType,
        headers: {
          "x-patchy-file-body": "1",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      });
    return json(reply);
  });
});

/** A separate scope-owned listener; loopback unless a private literal interface is opted in. */
export const listen = Effect.fn("CallbackGatewayApi.listen")(function* (options: Options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!privateHost(host, options.privateInterface === true))
    return yield* new ListenerRefused({ reason: "public_interface" });
  if (!validPort(port)) return yield* new ListenerRefused({ reason: "invalid_port" });
  const handler = yield* make;
  const server = yield* NodeHttpServer.make(createServer, { host, port }).pipe(
    Effect.mapError((cause) => new ListenerUnavailable({ host, port, cause }))
  );
  yield* server.serve(handler);
  if (server.address._tag === "UnixPathAddress")
    return yield* new ListenerRefused({ reason: "public_interface" });
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${server.address.port}/callback`
  };
});
