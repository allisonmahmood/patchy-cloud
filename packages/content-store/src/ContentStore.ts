/**
 * The content store: the platform's object store for a patch's bytes, one
 * HTML object per patch version under a key the patch records. Two layers
 * implement it — `FilesystemContentStore` for dev and tests,
 * `AzureContentStore` for production — chosen by the server's wiring, never
 * by an operator setting. "Storage" is reserved for the later per-patch file
 * primitive; this package is not that.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The key names no object: empty, or one that would leave the store's root. */
export class InvalidObjectKey extends Schema.TaggedError<InvalidObjectKey>()("InvalidObjectKey", {
  key: Schema.String
}) {
  override get message() {
    return `Invalid object key: ${JSON.stringify(this.key)}.`;
  }
}

/** A `get` for a key the store holds nothing under. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", {
  key: Schema.String
}) {
  override get message() {
    return `No object stored under ${this.key}.`;
  }
}

/**
 * The store could not carry an operation out — the disk or the blob service
 * refused. The driver's own error rides as `cause`.
 */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()("StoreUnavailable", {
  operation: Schema.Literals(["put", "get", "delete"]),
  key: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Content store could not ${this.operation} ${this.key}.`;
  }
}

/** What every layer refuses before touching its backend: an empty key, or one with a NUL in it. */
export const checkKey = (key: string): Effect.Effect<void, InvalidObjectKey> =>
  key.length === 0 || key.includes("\0") ? Effect.fail(new InvalidObjectKey({ key })) : Effect.void;

export class ContentStore extends Context.Service<
  ContentStore,
  {
    /** Writes the object, replacing whatever the key held. */
    readonly put: (
      key: string,
      html: string
    ) => Effect.Effect<void, InvalidObjectKey | StoreUnavailable>;
    /** Reads the object back as the string it was put as. */
    readonly get: (
      key: string
    ) => Effect.Effect<string, InvalidObjectKey | ObjectNotFound | StoreUnavailable>;
    /** Removes the object; a key already empty is a success. */
    readonly delete: (key: string) => Effect.Effect<void, InvalidObjectKey | StoreUnavailable>;
  }
>()("@patchy/content-store/ContentStore") {}
