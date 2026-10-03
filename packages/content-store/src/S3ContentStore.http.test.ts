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

const modified = "2026-01-02T03:04:05.000Z";
const object = (key?: string, lastModified?: string) =>
  `<Contents>${key === undefined ? "" : `<Key>${key}</Key>`}${
    lastModified === undefined ? "" : `<LastModified>${lastModified}</LastModified>`
  }</Contents>`;
const page = (truncated: boolean, next: string | undefined, contents: string) =>
  `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${truncated}</IsTruncated>${
    next === undefined ? "" : `<NextContinuationToken>${next}</NextContinuationToken>`
  }${contents}</ListBucketResult>`;

for (const [name, respond, requests] of [
  ["an object without a key", () => page(false, undefined, object(undefined, modified)), 1],
  ["an object without a modification time", () => page(false, undefined, object("listed/a")), 1],
  [
    "an invalid modification time",
    () => page(false, undefined, object("listed/a", "not-a-date")),
    1
  ],
  [
    "a truncated page without a continuation token",
    () => page(true, undefined, object("listed/a", modified)),
    1
  ],
  [
    "a continuation token that repeats the request's",
    () => page(true, "same", object("listed/a", modified)),
    2
  ],
  [
    "continuation tokens that cycle",
    (token: string | null) => page(true, token === "first" ? "second" : "first", ""),
    3
  ]
] as const) {
  it.effect(`fails a listing with ${name} after ${requests} request(s)`, () =>
    Effect.gen(function* () {
      let served = 0;
      const store = yield* makeTestStore((request, response) => {
        const url = new URL(request.url!, "http://localhost");
        // A listing that never stops is the failure under test; bound it so the case ends.
        const body =
          ++served > 10
            ? "<Error><Code>InternalError</Code></Error>"
            : respond(url.searchParams.get("continuation-token"));
        response.writeHead(served > 10 ? 500 : 200, { "content-type": "application/xml" });
        response.end(body);
      });
      const failure = yield* store.list("listed/").pipe(Stream.runCollect, Effect.flip);
      assert.deepInclude(failure, { _tag: "StoreUnavailable", operation: "list", key: "listed/" });
      assert.strictEqual(served, requests);
    })
  );
}
