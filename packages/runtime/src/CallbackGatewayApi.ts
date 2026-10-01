// @effect-diagnostics nodeBuiltinImport:off -- Node owns the private HTTP listener.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { isIP } from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { limitRefusal, RuntimeFailure } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
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
    if (request.method !== "POST" || request.url.split("?")[0] !== "/callback")
      return json(invalid);
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer "))
      return json({
        ok: false,
        source: "patchy",
        code: "access_denied",
        error: "An invocation capability is required."
      });
    const token = authorization.slice(7);
    const identity = yield* Effect.result(
      decodeIdentity({
        invocationId: request.headers["x-patchy-invocation-id"],
        attemptId: request.headers["x-patchy-attempt-id"],
        processGeneration: request.headers["x-patchy-process-generation"]
      })
    );
    if (identity._tag === "Failure") return json(invalid);
    const resolved = yield* Effect.result(capabilities.resolve(token, identity.success));
    if (resolved._tag === "Failure") return json(resolved.failure.failure);
    const capability = resolved.success;
    const countRefusal = capabilities.chargeCallback(capability);
    if (countRefusal !== undefined) return json(countRefusal);
    const raw = request.headers["x-patchy-callback"];
    const available = Math.max(0, byteLimit - capability.tree.bytes);
    const maxBytes = raw === undefined ? available : Math.min(fileLimit, available);
    const overflow = (bytes: number) =>
      raw !== undefined && fileLimit <= available
        ? new CallbackFileTooLarge({ maxBytes: fileLimit })
        : new CallbackBudgetExceeded({ failure: capabilities.chargeBytes(capability, bytes)! });
    const reply = yield* capabilities
      .execute(
        capability,
        Effect.gen(function* () {
          if (raw !== undefined) {
            const metadataBytes = Buffer.byteLength(raw);
            const failure = capabilities.chargeBytes(capability, metadataBytes);
            if (failure !== undefined) return yield* new CallbackBudgetExceeded({ failure });
          }
          const length = Number(request.headers["content-length"]);
          if (length > maxBytes) return yield* overflow(length);
          const chunks: Uint8Array[] = [];
          let size = 0;
          // Pull in the request scope so refusal is sent before closing the unread socket.
          const pull = yield* Stream.toPull(request.stream);
          while (true) {
            const batch = yield* pull.pipe(
              Pull.catchDone(() => Effect.void),
              Effect.mapError((cause) => new MalformedCallback({ cause }))
            );
            if (batch === undefined) break;
            for (const chunk of batch) {
              size += chunk.byteLength;
              if (size > maxBytes) return yield* overflow(chunk.byteLength);
              const failure = capabilities.chargeBytes(capability, chunk.byteLength);
              if (failure !== undefined) return yield* new CallbackBudgetExceeded({ failure });
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
        Effect.flatMap((callback) => gateway.callback(token, identity.success, callback, true)),
        Effect.catchTags({
          CapabilityRefused: (error) =>
            Effect.succeed(capabilities.rememberRefusal(capability, error.failure, 403)),
          MalformedCallback: () =>
            Effect.succeed(capabilities.rememberRefusal(capability, invalid, 400)),
          CallbackFileTooLarge: (error) =>
            Effect.succeed(
              capabilities.rememberRefusal(
                capability,
                {
                  ok: false,
                  source: "patchy",
                  error: error.message,
                  ...limitRefusal("tier2.callbacks.fileBytes", error.maxBytes)
                },
                413
              )
            ),
          CallbackBudgetExceeded: (error) => Effect.succeed(error.failure)
        })
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
