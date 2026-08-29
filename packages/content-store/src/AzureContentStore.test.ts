import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
    deleteIfExists: () => Effect.fail(down("deleteIfExists"))
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
        yield* service.delete("a.html").pipe(Effect.flip)
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
          ["delete", "a.html", down("deleteIfExists")]
        ]
      );
      // Refused before the container is asked, so an outage never masks it.
      assert.strictEqual((yield* service.get("").pipe(Effect.flip))._tag, "InvalidObjectKey");
    })
  );
});
