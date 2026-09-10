/**
 * The content store over an Azure Blob container: one block blob per object
 * key, served as HTML. The container is its own service (`BlobContainer`) so
 * the error mapping here can be exercised without an account.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as BlobContainer from "./BlobContainer.js";
import * as ContentStore from "./ContentStore.js";

export const make = Effect.gen(function* () {
  const blobs = yield* BlobContainer.BlobContainer;

  const put = Effect.fn("AzureContentStore.put")(function* (key: string, html: string) {
    yield* ContentStore.checkKey(key);
    yield* blobs
      .upload(key, html)
      .pipe(
        Effect.mapError(
          (cause) => new ContentStore.StoreUnavailable({ operation: "put", key, cause })
        )
      );
  });

  const get = Effect.fn("AzureContentStore.get")(function* (key: string) {
    yield* ContentStore.checkKey(key);
    return yield* blobs
      .download(key)
      .pipe(
        Effect.mapError((cause) =>
          Option.contains(cause.statusCode, 404)
            ? new ContentStore.ObjectNotFound({ key })
            : new ContentStore.StoreUnavailable({ operation: "get", key, cause })
        )
      );
  });

  const remove = Effect.fn("AzureContentStore.delete")(function* (key: string) {
    yield* ContentStore.checkKey(key);
    yield* blobs
      .deleteIfExists(key)
      .pipe(
        Effect.mapError(
          (cause) => new ContentStore.StoreUnavailable({ operation: "delete", key, cause })
        )
      );
  });

  const list = (prefix: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (prefix !== "") yield* ContentStore.checkKey(prefix);
        return blobs
          .list(prefix)
          .pipe(
            Stream.mapError(
              (cause) =>
                new ContentStore.StoreUnavailable({ operation: "list", key: prefix, cause })
            )
          );
      })
    );

  return ContentStore.ContentStore.of({ put, get, delete: remove, list });
});

export const layer = Layer.effect(ContentStore.ContentStore, make).pipe(
  Layer.provide(BlobContainer.layer)
);
