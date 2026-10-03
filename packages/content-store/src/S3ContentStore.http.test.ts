import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeTestStore } from "../test/S3HttpFixture.js";

for (const { status, code } of [
  { status: 403, code: "AccessDenied" },
  // A retryable 503 would only add SDK backoff; the mapping is the same.
  { status: 404, code: "NoSuchBucket" }
]) {
  it.effect(
    `reports ${code} as store unavailability, not an absent object`,
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore((_request, response) => {
          response.writeHead(status, { "content-type": "application/xml" });
          response.end(`<Error><Code>${code}</Code><Message>Unavailable</Message></Error>`);
        });
        const key = "errors/object";
        for (const [operation, result] of [
          ["put", store.put(key, "text")],
          ["put", store.putBytes(key, new Uint8Array([1]))],
          ["get", store.get(key).pipe(Effect.asVoid)],
          ["get", store.getBytes(key).pipe(Effect.asVoid)],
          ["delete", store.delete(key)],
          ["list", store.list(key).pipe(Stream.runDrain)]
        ] as const) {
          const failure = yield* result.pipe(Effect.flip);
          assert.deepInclude(failure, { _tag: "StoreUnavailable", operation, key });
        }
      }),
    30_000
  );
}

it.effect("maps NoSuchKey responses to ObjectNotFound with the requested key", () =>
  Effect.gen(function* () {
    const store = yield* makeTestStore((_request, response) => {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code><Message>Missing</Message></Error>");
    });
    const key = "errors/missing";
    const missing = yield* store.getBytes(key).pipe(Effect.flip);
    assert.deepInclude(missing, { _tag: "ObjectNotFound", key });
  })
);

it.effect("fails rather than returning a truncated GetObject body", () =>
  Effect.gen(function* () {
    const store = yield* makeTestStore((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "100",
        connection: "close"
      });
      response.end("only part of the declared body");
    });
    const key = "errors/truncated";
    const failure = yield* store.getBytes(key).pipe(Effect.flip);
    assert.deepInclude(failure, { _tag: "StoreUnavailable", operation: "get", key });
  })
);
