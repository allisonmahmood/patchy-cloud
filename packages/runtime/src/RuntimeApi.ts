import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PatchyApi, RuntimeEnvelope, RuntimeFailure } from "@patchy/api";
import * as Runtime from "./Runtime.js";

const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeEnvelope), {
  onExcessProperty: "error"
});
const decodeBytes = Schema.decodeUnknownEffect(Schema.Uint8Array);
const decodeWire = Schema.decodeUnknownEffect(Schema.NumberFromString);
const encodeFailure = Schema.encodeSync(RuntimeFailure);
const noStore = { "cache-control": "no-store" };

const failureStatus = {
  session_expired: 401,
  access_denied: 403,
  not_available_on_public: 403,
  principal_changed: 409,
  shell_outdated: 409,
  too_large: 413,
  rate_limited: 429,
  source_unavailable: 503,
  busy: 503,
  timeout: 503,
  unknown_outcome: 503
} as const;

export const failure = (error: Runtime.RuntimeError) =>
  HttpServerResponse.jsonUnsafe(
    encodeFailure({
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId })
    }),
    {
      status:
        error.code in failureStatus ? failureStatus[error.code as keyof typeof failureStatus] : 400,
      headers: {
        ...noStore,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(error.retryAfterSeconds) })
      }
    }
  );

/** Count actual bytes, not Content-Length, and stop collecting before decoding an overflow. */
const readCall = Effect.fn("RuntimeApi.readCall")(function* (runtime: Runtime.Runtime["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > runtime.maxCallBytes)
    return yield* new Runtime.RuntimeError({ code: "too_large", maxBytes: runtime.maxCallBytes });
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  yield* request.stream.pipe(
    Stream.mapError((cause) => new Runtime.RuntimeError({ code: "invalid_request", cause })),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        size += chunk.byteLength;
        if (size > runtime.maxCallBytes)
          return yield* new Runtime.RuntimeError({
            code: "too_large",
            maxBytes: runtime.maxCallBytes
          });
        text += decoder.decode(chunk, { stream: true });
      })
    )
  );
  text += decoder.decode();
  const input = yield* decodeCall(text).pipe(
    Effect.mapError((cause) => new Runtime.RuntimeError({ code: "invalid_request", cause }))
  );
  const maxBytes = runtime.bodyLimit(input.op);
  if (size > maxBytes) return yield* new Runtime.RuntimeError({ code: "too_large", maxBytes });
  return input;
});

export const layer = HttpApiBuilder.group(PatchyApi, "runtime", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const file = Effect.fn("RuntimeApi.file")(function* (params: Readonly<Record<string, string>>) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const wire = yield* decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.RuntimeError({ code: "invalid_request", cause }))
      );
      if (request.method === "PUT" && Number(request.headers["content-length"]) > runtime.fileBytes)
        return yield* new Runtime.RuntimeError({ code: "too_large", maxBytes: runtime.fileBytes });
      // File handlers are not registered until the Files ticket. They still pass the same admission.
      const value = yield* runtime.call({
        patchId: params.patchId ?? "",
        versionId: params.versionId ?? "",
        principal: null,
        wire,
        op: request.method === "PUT" ? "files.put" : "files.get",
        args: {
          store: params.store,
          name: params["*"],
          contentType: request.headers["content-type"]
        }
      });
      const bytes = yield* decodeBytes(value).pipe(
        Effect.mapError((cause) => new Runtime.RuntimeError({ code: "source_unavailable", cause }))
      );
      return HttpServerResponse.uint8Array(bytes, { headers: noStore });
    });
    return handlers
      .handleRaw("call", () =>
        readCall(runtime).pipe(
          Effect.flatMap(runtime.call),
          Effect.map((value) =>
            HttpServerResponse.jsonUnsafe({ ok: true, value }, { headers: noStore })
          ),
          Effect.catchTags({ RuntimeError: (error) => Effect.succeed(failure(error)) })
        )
      )
      .handleRaw("putFile", ({ params }) =>
        file(params).pipe(
          Effect.catchTags({ RuntimeError: (error) => Effect.succeed(failure(error)) })
        )
      )
      .handleRaw("getFile", ({ params }) =>
        file(params).pipe(
          Effect.catchTags({ RuntimeError: (error) => Effect.succeed(failure(error)) })
        )
      );
  })
);
