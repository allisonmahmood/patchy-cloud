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
import { ContractLimits } from "@patchy/limits";
import * as Runtime from "./Runtime.js";

const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeEnvelope), {
  onExcessProperty: "error"
});
const encodeSuccess = Schema.encodeUnknownEffect(RuntimeSuccess);
const encodeServerReply = Schema.encodeUnknownEffect(ServerCallReply);
const encodeFailure = Schema.encodeSync(RuntimeFailure);
const noStore = { "cache-control": "no-store" };

export const failure = (error: Runtime.RuntimeError) => {
  const body = Runtime.toFailure(error);
  return HttpServerResponse.jsonUnsafe(encodeFailure(body), {
    status: error.status,
    headers: {
      ...noStore,
      ...(body.retryAfter === undefined ? {} : { "retry-after": String(body.retryAfter) })
    }
  });
};

const recordFailure = Effect.fnUntraced(function* (error: Runtime.RuntimeError) {
  yield* WideEvents.enrich({
    outcome:
      error.code === "unknown_outcome"
        ? "unknown_outcome"
        : error.code === "source_unavailable" ||
            error.code === "timeout" ||
            error.code === "handler_failed" ||
            error.code === "handler_timeout"
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
    return yield* WideEvents.enrich({
      limits: [
        {
          limitId: runtime.maxCallLimitId,
          value: runtime.maxCallBytes,
          peak: Number(request.headers["content-length"]),
          configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
        }
      ]
    }).pipe(
      Effect.andThen(
        new Runtime.TooLarge({
          maxBytes: runtime.maxCallBytes,
          limitId: runtime.maxCallLimitId
        })
      )
    );
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  yield* forEachBodyChunk(request, (chunk) =>
    Effect.gen(function* () {
      size += chunk.byteLength;
      yield* WideEvents.enrich({
        requestBytes: size,
        limits: [
          {
            limitId: runtime.maxCallLimitId,
            value: runtime.maxCallBytes,
            peak: size,
            configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
          }
        ]
      });
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

/** Read only after admission and, for ordinary puts, the mutation log's begin. */
const readFile = Effect.fn("RuntimeApi.readFile")(function* (
  maxBytes: number,
  limitId: "runtime.file.bytes" | "files.stage.bytes"
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > maxBytes) {
    yield* WideEvents.enrich({
      limits: [
        {
          limitId,
          value: maxBytes,
          peak: Number(request.headers["content-length"]),
          configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
        }
      ]
    });
    return yield* new Runtime.TooLarge({ maxBytes, limitId });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* forEachBodyChunk(request, (chunk) =>
    Effect.gen(function* () {
      size += chunk.byteLength;
      yield* WideEvents.enrich({
        requestBytes: size,
        limits: [
          {
            limitId,
            value: maxBytes,
            peak: size,
            configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
          }
        ]
      });
      if (size > maxBytes) return yield* new Runtime.TooLarge({ maxBytes, limitId });
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
    const stageBytes = yield* ContractLimits.get("files.stage.bytes");
    const file = Effect.fn("RuntimeApi.file")(function* (
      params: Readonly<Record<string, string>>,
      mode: "owned" | "shared" | "handle" | "stage" = "owned"
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const operation =
        mode === "stage"
          ? "files.stage"
          : mode === "handle"
            ? "files.redeem"
            : mode === "shared"
              ? "shared.files.get"
              : request.method === "PUT"
                ? "files.put"
                : "files.get";
      yield* WideEvents.operation(operation);
      const wire = yield* Runtime.decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const input = {
        patchId: params.patchId ?? "",
        versionId: params.versionId ?? "",
        principal: null,
        wire,
        op: operation,
        args:
          mode === "stage"
            ? { contentType: request.headers["content-type"] ?? "application/octet-stream" }
            : mode === "handle"
              ? { handle: params.handle }
              : {
                  ...(mode === "shared" ? { alias: params.alias } : { store: params.store }),
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
          readFile(
            mode === "stage" ? stageBytes : runtime.fileBytes,
            mode === "stage" ? "files.stage.bytes" : "runtime.file.bytes"
          ).pipe(Effect.provideService(Scope.Scope, scope))
        );
        const body = yield* encodeSuccess({ ok: true, value }).pipe(
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        return HttpServerResponse.jsonUnsafe(body, { headers: noStore });
      }
      const result = yield* runtime.getFile(input);
      yield* WideEvents.enrich({
        limits: [
          {
            limitId: "runtime.file.bytes",
            value: runtime.fileBytes,
            peak: result.bytes.byteLength,
            configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
          }
        ]
      });
      return HttpServerResponse.uint8Array(result.bytes, {
        contentType: result.contentType,
        headers: {
          ...noStore,
          ...(result.name === undefined
            ? {}
            : { "x-patchy-file-name": encodeURIComponent(result.name) }),
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
            Effect.catch(recordFailure),
            Effect.tap((response) =>
              WideEvents.enrich({
                responseBytes:
                  response.body._tag === "Uint8Array" ? response.body.body.byteLength : 0
              })
            )
          )
        )
      )
      .handleRaw("stageFile", ({ params }) =>
        events.withEvent(
          { type: "request" },
          file(params, "stage").pipe(
            Effect.catch(recordFailure),
            Effect.tap((response) =>
              WideEvents.enrich({
                responseBytes:
                  response.body._tag === "Uint8Array" ? response.body.body.byteLength : 0
              })
            )
          )
        )
      )
      .handleRaw("putFile", ({ params }) =>
        events.withEvent(
          { type: "request" },
          file(params).pipe(
            Effect.catch(recordFailure),
            Effect.tap((response) =>
              WideEvents.enrich({
                responseBytes:
                  response.body._tag === "Uint8Array" ? response.body.body.byteLength : 0
              })
            )
          )
        )
      )
      .handleRaw("getFile", ({ params }) =>
        events.withEvent(
          { type: "request" },
          file(params).pipe(
            Effect.catch(recordFailure),
            Effect.tap((response) =>
              WideEvents.enrich({
                responseBytes:
                  response.body._tag === "Uint8Array" ? response.body.body.byteLength : 0
              })
            )
          )
        )
      )
      .handleRaw("getSharedFile", ({ params }) =>
        events.withEvent(
          { type: "request" },
          file(params, "shared").pipe(
            Effect.catch(recordFailure),
            Effect.tap((response) =>
              WideEvents.enrich({
                responseBytes:
                  response.body._tag === "Uint8Array" ? response.body.body.byteLength : 0
              })
            )
          )
        )
      )
      .handleRaw("redeemFile", ({ params }) =>
        events.withEvent(
          { type: "request" },
          file(params, "handle").pipe(
            Effect.catch(recordFailure),
            Effect.tap((response) =>
              WideEvents.enrich({
                responseBytes:
                  response.body._tag === "Uint8Array" ? response.body.body.byteLength : 0
              })
            )
          )
        )
      );
  })
);
