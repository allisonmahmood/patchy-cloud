// PROTOTYPE for #315: the two shell-level file exceptions on the server-only tier 2 client
// (#303 points 7 and 8), admitted by the runtime like every other call.
//
//   PUT /api/runtime/uploads/:patchId/:versionId           bytes in, an Upload out (unlogged)
//   GET /api/runtime/handles/:patchId/:versionId/:handle   bytes of one handle (unlogged read)
//
// Redemption answers 304 when the shell sends the object id it already holds as If-None-Match
// and the handle is still authorised: the shell's byte cache never skips the live check.
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Runtime from "./Runtime.js";
import { failure } from "./RuntimeApi.js";

const noStore = { "cache-control": "no-store" };

const readBytes = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > maxBytes)
      return yield* new Runtime.TooLarge({ maxBytes });
    const buffer = yield* request.arrayBuffer.pipe(
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
    );
    if (buffer.byteLength > maxBytes) return yield* new Runtime.TooLarge({ maxBytes });
    return new Uint8Array(buffer);
  });

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const envelope = Effect.fn("FileRoutes.envelope")(function* (
      op: "files.stage" | "files.redeem",
      args: Readonly<Record<string, unknown>>
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const wire = yield* Runtime.decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      return {
        patchId: params.patchId ?? "",
        versionId: params.versionId ?? "",
        principal: null,
        wire,
        op,
        args
      };
    });
    const stage = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* envelope("files.stage", {
        contentType: request.headers["content-type"] ?? "application/octet-stream"
      });
      const value = yield* runtime.putFile(input, readBytes(runtime.fileBytes));
      return HttpServerResponse.jsonUnsafe({ ok: true, value }, { headers: noStore });
    });
    const redeem = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const ifNoneMatch = request.headers["if-none-match"];
      const input = yield* envelope("files.redeem", {
        handle: params.handle ?? "",
        ...(ifNoneMatch === undefined ? {} : { ifNoneMatch: ifNoneMatch.replaceAll('"', "") })
      });
      const result = yield* runtime.getFile(input);
      const headers = {
        ...noStore,
        "x-content-type-options": "nosniff",
        // Stored bytes are never a same-origin executable document.
        "content-security-policy": "sandbox; default-src 'none'; frame-src 'none'",
        "content-disposition": "attachment",
        ...(result.etag === undefined ? {} : { etag: `"${result.etag}"` }),
        ...(result.name === undefined
          ? {}
          : { "x-patchy-file-name": encodeURIComponent(result.name) })
      };
      if (result.notModified === true) return HttpServerResponse.empty({ status: 304, headers });
      return HttpServerResponse.uint8Array(result.bytes, {
        contentType: result.contentType,
        headers
      });
    });
    yield* router.add("PUT", "/api/runtime/uploads/:patchId/:versionId", () =>
      stage.pipe(Effect.catch((error) => Effect.succeed(failure(error))))
    );
    yield* router.add("GET", "/api/runtime/handles/:patchId/:versionId/:handle", () =>
      redeem.pipe(Effect.catch((error) => Effect.succeed(failure(error))))
    );
  })
);
