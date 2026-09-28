import { createServer, type RequestListener, type Server } from "node:http";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as S3ContentStore from "./S3ContentStore.js";

const storeForResponse = (respond: RequestListener) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<Server>((resolve, reject) => {
            const server = createServer(respond);
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server));
          })
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            })
        )
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an isolated TCP listener");
    }
    return yield* S3ContentStore.make.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PATCHY_S3_BUCKET: "contract-errors",
            PATCHY_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
            PATCHY_S3_REGION: "us-east-1",
            PATCHY_S3_ACCESS_KEY_ID: "test-access-key",
            PATCHY_S3_SECRET_ACCESS_KEY: "test-secret-key"
          })
        )
      )
    );
  });

for (const { status, code } of [
  { status: 403, code: "AccessDenied" },
  { status: 404, code: "NoSuchBucket" },
  { status: 503, code: "ServiceUnavailable" }
]) {
  it.effect(
    `reports ${code} as store unavailability, not an absent object`,
    () =>
      Effect.gen(function* () {
        const store = yield* storeForResponse((_request, response) => {
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
    const store = yield* storeForResponse((_request, response) => {
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
    const store = yield* storeForResponse((_request, response) => {
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
