import { RestError } from "@azure/storage-blob";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AzureContentStore from "./AzureContentStore.js";
import * as ContentStore from "./ContentStore.js";

const store = Effect.flatMap(ContentStore.ContentStore, Effect.succeed);

const outage = new Error("connection refused");

/** A container whose service is down, except that one key it has never seen. */
const failingContainer = Layer.succeed(
  AzureContentStore.BlobContainer,
  AzureContentStore.BlobContainer.of({
    upload: () => Promise.reject(outage),
    download: (key) =>
      Promise.reject(
        key === "missing.html"
          ? new RestError("The specified blob does not exist.", { statusCode: 404 })
          : outage
      ),
    deleteIfExists: () => Promise.reject(outage)
  })
);

it.layer(
  Layer.effect(ContentStore.ContentStore, AzureContentStore.make).pipe(
    Layer.provide(failingContainer)
  )
)("AzureContentStore", (it) => {
  it.effect("maps a 404 to ObjectNotFound and anything else to StoreUnavailable", () =>
    Effect.gen(function* () {
      const service = yield* store;
      const missing = yield* service.get("missing.html").pipe(Effect.flip);
      assert.strictEqual(missing._tag, "ObjectNotFound");
      assert.strictEqual(missing.key, "missing.html");

      const failures = [
        yield* service.put("a.html", "<h1>hi</h1>").pipe(Effect.flip),
        yield* service.get("a.html").pipe(Effect.flip),
        yield* service.delete("a.html").pipe(Effect.flip)
      ];
      assert.deepStrictEqual(
        failures.map((failure) => [failure._tag, failure.key, failure.cause]),
        [
          ["StoreUnavailable", "a.html", outage],
          ["StoreUnavailable", "a.html", outage],
          ["StoreUnavailable", "a.html", outage]
        ]
      );
      assert.deepStrictEqual(
        failures.map((failure) => (failure._tag === "StoreUnavailable" ? failure.operation : null)),
        ["put", "get", "delete"]
      );
    })
  );
});
