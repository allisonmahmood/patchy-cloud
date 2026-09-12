/**
 * The content store: the platform's object store for patch bytes. HTML lives
 * under version keys; immutable file objects live under files/. Two layers
 * implement it — FilesystemContentStore for dev and tests and AzureContentStore
 * for production. Object listing is infrastructure for orphan reclamation,
 * not the file primitive's indexed, authorised list operation.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

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
  operation: Schema.Literals(["put", "get", "delete", "list"]),
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

export interface StoredObject {
  readonly key: string;
  /** Last modification time in milliseconds since the Unix epoch. */
  readonly lastModified: number;
}

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
    /** Lazily enumerates objects whose keys start with prefix; empty means all objects. */
    readonly list: (
      prefix: string
    ) => Stream.Stream<StoredObject, InvalidObjectKey | StoreUnavailable>;
  }
>()("@patchy/content-store/ContentStore") {}
