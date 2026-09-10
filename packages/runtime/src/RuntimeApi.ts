import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PatchyApi, RuntimeEnvelope, RuntimeFailure, RuntimeSuccess } from "@patchy/api";
import * as Runtime from "./Runtime.js";

const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeEnvelope), {
  onExcessProperty: "error"
});
const encodeSuccess = Schema.encodeUnknownEffect(RuntimeSuccess);
const encodeFailure = Schema.encodeSync(RuntimeFailure);
const noStore = { "cache-control": "no-store" };

export const failure = (error: Runtime.RuntimeError) =>
  HttpServerResponse.jsonUnsafe(
    encodeFailure({
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId })
    }),
    {
      status: error.status,
      headers: {
        ...noStore,
        ...(!("retryAfterSeconds" in error) || error.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(error.retryAfterSeconds) })
      }
    }
  );

/** Count actual bytes, not Content-Length, and stop collecting before decoding an overflow. */
const readCall = Effect.fn("RuntimeApi.readCall")(function* (runtime: Runtime.Runtime["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > runtime.maxCallBytes)
    return yield* new Runtime.TooLarge({ maxBytes: runtime.maxCallBytes });
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  yield* request.stream.pipe(
    Stream.mapError((cause) => new Runtime.InvalidRequest({ cause })),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        size += chunk.byteLength;
        if (size > runtime.maxCallBytes)
          return yield* new Runtime.TooLarge({ maxBytes: runtime.maxCallBytes });
        text += decoder.decode(chunk, { stream: true });
      })
    )
  );
  text += decoder.decode();
  const input = yield* decodeCall(text).pipe(
    Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
  );
  const maxBytes = runtime.bodyLimit(input.op);
  if (size > maxBytes) return yield* new Runtime.TooLarge({ maxBytes });
  return input;
});

export const layer = HttpApiBuilder.group(PatchyApi, "runtime", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const file = Effect.fn("RuntimeApi.file")(function* (params: Readonly<Record<string, string>>) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const wire = yield* Runtime.decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      if (request.method === "PUT" && Number(request.headers["content-length"]) > runtime.fileBytes)
        return yield* new Runtime.TooLarge({ maxBytes: runtime.fileBytes });
      // File handlers are not registered until the Files ticket. They still pass the same admission.
      yield* runtime.call({
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
      return yield* new Runtime.InvalidRequest({});
    });
    return handlers
      .handleRaw("call", () =>
        readCall(runtime).pipe(
          Effect.flatMap(runtime.call),
          Effect.flatMap((value) =>
            encodeSuccess({ ok: true, value }).pipe(
              Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
            )
          ),
          Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: noStore })),
          Effect.catch((error) => Effect.succeed(failure(error)))
        )
      )
      .handleRaw("putFile", ({ params }) =>
        file(params).pipe(Effect.catch((error) => Effect.succeed(failure(error))))
      )
      .handleRaw("getFile", ({ params }) =>
        file(params).pipe(Effect.catch((error) => Effect.succeed(failure(error))))
      );
  })
);
