/**
 * The content store over a directory on local disk: one file per object key,
 * relative to a root the key may never escape. What `pnpm dev` and the tests
 * run on.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ContentStore from "./ContentStore.js";

/** Where the objects land. */
export const rootDir = Config.string("PATCHY_STORAGE_DIR").pipe(
  Config.withDefault(".local/patches")
);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(yield* rootDir);

  /** The key's file, or `InvalidObjectKey` when it names nothing under the root. */
  const resolveKey = Effect.fn(function* (key: string) {
    yield* ContentStore.checkKey(key);
    const resolved = path.resolve(root, key);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* Effect.fail(new ContentStore.InvalidObjectKey({ key }));
    }
    return resolved;
  });

  const put = Effect.fn("FilesystemContentStore.put")(function* (key: string, html: string) {
    const file = yield* resolveKey(key);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(file, html)),
      Effect.mapError(
        (cause) => new ContentStore.StoreUnavailable({ operation: "put", key, cause })
      )
    );
  });

  const get = Effect.fn("FilesystemContentStore.get")(function* (key: string) {
    const file = yield* resolveKey(key);
    return yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((cause) =>
          cause.reason._tag === "NotFound"
            ? new ContentStore.ObjectNotFound({ key })
            : new ContentStore.StoreUnavailable({ operation: "get", key, cause })
        )
      );
  });

  const remove = Effect.fn("FilesystemContentStore.delete")(function* (key: string) {
    const file = yield* resolveKey(key);
    yield* fs
      .remove(file, { force: true })
      .pipe(
        Effect.mapError(
          (cause) => new ContentStore.StoreUnavailable({ operation: "delete", key, cause })
        )
      );
  });

  return ContentStore.ContentStore.of({ put, get, delete: remove });
});

export const layer = Layer.effect(ContentStore.ContentStore, make).pipe(
  Layer.provide([NodeFileSystem.layer, NodePath.layer])
);
