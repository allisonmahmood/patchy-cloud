import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as AzureContentStore from "./AzureContentStore.js";
import * as BlobContainer from "./BlobContainer.js";
import * as ContentStore from "./ContentStore.js";

const outage = new Error("connection refused");

const down = (operation: BlobContainer.BlobRequestFailed["operation"]) =>
  new BlobContainer.BlobRequestFailed({ operation, statusCode: Option.none(), cause: outage });

/** A container whose service is down, except that one key it has never seen. */
const failingContainer = Layer.succeed(
  BlobContainer.BlobContainer,
  BlobContainer.BlobContainer.of({
    upload: () => Effect.fail(down("upload")),
    download: (key) =>
      Effect.fail(
        key === "missing.html"
          ? new BlobContainer.BlobRequestFailed({
              operation: "download",
              statusCode: Option.some(404),
              cause: new Error("The specified blob does not exist.")
            })
          : down("download")
      ),
    deleteIfExists: () => Effect.fail(down("deleteIfExists")),
    list: () => Stream.fail(down("list"))
  })
);

it.layer(
  Layer.effect(ContentStore.ContentStore, AzureContentStore.make).pipe(
    Layer.provide(failingContainer)
  )
)("AzureContentStore", (it) => {
  it.effect("maps a 404 to ObjectNotFound and anything else to StoreUnavailable", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      const missing = yield* service.get("missing.html").pipe(Effect.flip);
      assert.strictEqual(missing._tag, "ObjectNotFound");
      assert.strictEqual(missing.key, "missing.html");

      const failures = [
        yield* service.put("a.html", "<h1>hi</h1>").pipe(Effect.flip),
        yield* service.get("a.html").pipe(Effect.flip),
        yield* service.delete("a.html").pipe(Effect.flip),
        yield* service.list("files/").pipe(Stream.runCollect, Effect.flip)
      ];
      assert.deepStrictEqual(
        failures.map((failure) =>
          failure._tag === "StoreUnavailable"
            ? [failure.operation, failure.key, failure.cause]
            : failure._tag
        ),
        [
          ["put", "a.html", down("upload")],
          ["get", "a.html", down("download")],
          ["delete", "a.html", down("deleteIfExists")],
          ["list", "files/", down("list")]
        ]
      );
      // Refused before the container is asked, so an outage never masks it.
      assert.strictEqual((yield* service.get("").pipe(Effect.flip))._tag, "InvalidObjectKey");
    })
  );
});

it.effect("preserves binary objects and UTF-8 text through the Azure adapter", () =>
  Effect.gen(function* () {
    const objects = new Map<string, Uint8Array>();
    const container = Layer.succeed(BlobContainer.BlobContainer, {
      upload: (key, bytes) =>
        Effect.sync(() => {
          objects.set(key, bytes.slice());
        }),
      download: (key) =>
        Effect.suspend(() => {
          const bytes = objects.get(key);
          return bytes === undefined
            ? Effect.fail(
                new BlobContainer.BlobRequestFailed({
                  operation: "download",
                  statusCode: Option.some(404),
                  cause: new Error("Object does not exist")
                })
              )
            : Effect.succeed(bytes.slice());
        }),
      deleteIfExists: (key) =>
        Effect.sync(() => {
          objects.delete(key);
        }),
      list: (prefix) =>
        Stream.fromIterable(
          Array.from(objects.keys())
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key, lastModified: 0 }))
        )
    });
    const service = yield* AzureContentStore.make.pipe(Effect.provide(container));
    const binary = new Uint8Array([0, 255, 128, 192, 10]);
    yield* service.putBytes("files/patch/docs/obj", binary);
    assert.deepStrictEqual(yield* service.getBytes("files/patch/docs/obj"), binary);
    const html = "\uFEFF<h1>こんにちは — café</h1>";
    yield* service.put("versions/page.html", html);
    assert.strictEqual(yield* service.get("versions/page.html"), html);
    assert.deepStrictEqual(
      yield* service.getBytes("versions/page.html"),
      new TextEncoder().encode(html)
    );
    yield* service.putBytes("versions/bytes.html", new TextEncoder().encode(html));
    assert.strictEqual(yield* service.get("versions/bytes.html"), html);
  })
);
