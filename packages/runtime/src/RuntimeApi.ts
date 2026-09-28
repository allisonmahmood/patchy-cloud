import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  PatchyApi,
  RuntimeEnvelope,
  RuntimeFailure,
  RuntimeSuccess,
  ServerCallReply
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Runtime from "./Runtime.js";

const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeEnvelope), {
  onExcessProperty: "error"
});
const encodeSuccess = Schema.encodeUnknownEffect(RuntimeSuccess);
const encodeServerReply = Schema.encodeUnknownEffect(ServerCallReply);
const encodeFailure = Schema.encodeSync(RuntimeFailure);
const noStore = { "cache-control": "no-store" };

export const failure = (error: Runtime.RuntimeError) => {
  const retryAfter =
    (error.code === "rate_limited" ||
      error.code === "limit_exceeded" ||
      error.code === "too_many_requests" ||
      error.code === "busy") &&
    "retryAfterSeconds" in error
      ? error.retryAfterSeconds
      : undefined;
  return HttpServerResponse.jsonUnsafe(
    encodeFailure({
      ok: false,
      source: "patchy",
      code: error.code,
      error: error.message,
      ...("limitId" in error && error.limitId !== undefined ? { limitId: error.limitId } : {}),
      ...("limitId" in error && error.limitId !== undefined && error.scope !== undefined
        ? { scope: error.scope }
        : {}),
      ...("limitId" in error && error.limitId !== undefined && error.value !== undefined
        ? { value: error.value }
        : {}),
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...("details" in error && error.details !== undefined ? { details: error.details } : {}),
      ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId })
    }),
    {
      status: error.status,
      headers: {
        ...noStore,
        ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) })
      }
    }
  );
};

const recordFailure = Effect.fnUntraced(function* (error: Runtime.RuntimeError) {
  yield* WideEvents.enrich({
    outcome:
      error.code === "unknown_outcome"
        ? "unknown_outcome"
        : error.code === "source_unavailable" || error.code === "timeout"
          ? "failure"
          : "refused",
    code: error.code,
    ...("limitId" in error && error.limitId !== undefined ? { limitId: error.limitId } : {})
  });
  return failure(error);
});

/** Keep the stream finalizer in the request scope, after its refusal response.
 * A stream runner's inner scope would destroy Node's socket before sending 413.
 * Pulling stops at overflow; the unread remainder is never drained or buffered.
 */
const forEachBodyChunk = Effect.fn("RuntimeApi.forEachBodyChunk")(function* (
  request: HttpServerRequest.HttpServerRequest,
  consume: (chunk: Uint8Array) => Effect.Effect<void, Runtime.RuntimeError>
) {
  const pull = yield* Stream.toPull(request.stream);
  while (true) {
    const chunks = yield* pull.pipe(
      Pull.catchDone(() => Effect.void),
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
    );
    if (!chunks) return;
    for (const chunk of chunks) yield* consume(chunk);
  }
});

/** Count actual bytes, not Content-Length, and stop collecting before decoding an overflow. */
const readCall = Effect.fn("RuntimeApi.readCall")(function* (runtime: Runtime.Runtime["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > runtime.maxCallBytes)
    return yield* new Runtime.TooLarge({
      maxBytes: runtime.maxCallBytes,
      limitId: runtime.maxCallLimitId
    });
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  yield* forEachBodyChunk(request, (chunk) =>
    Effect.gen(function* () {
      size += chunk.byteLength;
      if (size > runtime.maxCallBytes)
        return yield* new Runtime.TooLarge({
          maxBytes: runtime.maxCallBytes,
          limitId: runtime.maxCallLimitId
        });
      text += decoder.decode(chunk, { stream: true });
    })
  );
  text += decoder.decode();
  const input = yield* decodeCall(text).pipe(
    Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
  );
  return { input, byteLength: size };
});

/** This effect is evaluated by Runtime only after admission and the mutation log's begin. */
const readFile = Effect.fn("RuntimeApi.readFile")(function* (maxBytes: number) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > maxBytes)
    return yield* new Runtime.TooLarge({ maxBytes, limitId: "runtime.file.bytes" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* forEachBodyChunk(request, (chunk) =>
    Effect.gen(function* () {
      size += chunk.byteLength;
      if (size > maxBytes)
        return yield* new Runtime.TooLarge({ maxBytes, limitId: "runtime.file.bytes" });
      chunks.push(chunk);
    })
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

export const layer = HttpApiBuilder.group(PatchyApi, "runtime", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const events = yield* WideEvents.WideEvents;
    const file = Effect.fn("RuntimeApi.file")(function* (params: Readonly<Record<string, string>>) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const operation = request.method === "PUT" ? "files.put" : "files.get";
      yield* WideEvents.operation(operation);
      const wire = yield* Runtime.decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const input = {
        patchId: params.patchId ?? "",
        versionId: params.versionId ?? "",
        principal: null,
        wire,
        op: request.method === "PUT" ? "files.put" : "files.get",
        args: {
          store: params.store,
          name: params["*"],
          ...(request.method === "PUT"
            ? { contentType: request.headers["content-type"] ?? "application/octet-stream" }
            : {})
        }
      };
      if (request.method === "PUT") {
        const scope = yield* Scope.Scope;
        const value = yield* runtime.putFile(
          input,
          readFile(runtime.fileBytes).pipe(Effect.provideService(Scope.Scope, scope))
        );
        const body = yield* encodeSuccess({ ok: true, value }).pipe(
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        return HttpServerResponse.jsonUnsafe(body, { headers: noStore });
      }
      const result = yield* runtime.getFile(input);
      return HttpServerResponse.uint8Array(result.bytes, {
        contentType: result.contentType,
        headers: {
          ...noStore,
          "x-content-type-options": "nosniff",
          // Active uploads are bytes, never a same-origin executable document.
          "content-security-policy": "sandbox; default-src 'none'; frame-src 'none'",
          "content-disposition": "attachment"
        }
      });
    });
    return handlers
      .handleRaw("call", () =>
        events.withEvent(
          { type: "request" },
          readCall(runtime).pipe(
            Effect.flatMap(({ input, byteLength }) =>
              runtime
                .call(input, byteLength)
                .pipe(
                  Effect.flatMap((value) =>
                    (input.op === "server.call"
                      ? encodeServerReply(value)
                      : encodeSuccess({ ok: true, value })
                    ).pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
                  )
                )
            ),
            Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: noStore })),
            Effect.catch(recordFailure)
          )
        )
      )
      .handleRaw("putFile", ({ params }) =>
        events.withEvent({ type: "request" }, file(params).pipe(Effect.catch(recordFailure)))
      )
      .handleRaw("getFile", ({ params }) =>
        events.withEvent({ type: "request" }, file(params).pipe(Effect.catch(recordFailure)))
      );
  })
);
