/**
 * PROTOTYPE (#176). The files primitive: named files in a patch's file
 * store. Bytes go to the `ContentStore` (the disk in dev, Azure Blob in
 * production) under a key the patch's namespace owns; the index row — name,
 * size, content type — sits in the `_files` table `Tables.provision` creates
 * in the same namespace, so listing is a query and the store needs no list.
 *
 * The content store holds strings today (one HTML object per version), so
 * the bytes ride as base64 here. A real build gives the store a bytes path.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ContentStore } from "@patchy/content-store";
import { FILES_INDEX } from "./Tables.js";

export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  store: Schema.String,
  name: Schema.String
}) {
  override get message() {
    return `No file ${this.name} in store ${this.store}.`;
  }
}

/** A file name the store refuses: empty, over 255 bytes, or with a path separator or control character. */
export class InvalidFileName extends Schema.TaggedError<InvalidFileName>()("InvalidFileName", {
  name: Schema.String
}) {
  override get message() {
    return `Invalid file name ${JSON.stringify(this.name)}.`;
  }
}

export interface StoredFile {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: string;
}

type StoreFailure = ContentStore.InvalidObjectKey | ContentStore.StoreUnavailable;

export class Files extends Context.Service<
  Files,
  {
    readonly put: (
      namespace: string,
      store: string,
      name: string,
      bytes: Uint8Array,
      contentType: string
    ) => Effect.Effect<StoredFile, InvalidFileName | StoreFailure | SqlError>;
    readonly get: (
      namespace: string,
      store: string,
      name: string
    ) => Effect.Effect<
      { readonly bytes: Uint8Array; readonly file: StoredFile },
      FileNotFound | StoreFailure | SqlError
    >;
    readonly list: (
      namespace: string,
      store: string
    ) => Effect.Effect<ReadonlyArray<StoredFile>, SqlError>;
    readonly delete: (
      namespace: string,
      store: string,
      name: string
    ) => Effect.Effect<void, StoreFailure | SqlError>;
  }
>()("@patchy/primitives/Files") {}

class IndexRow extends Schema.Class<IndexRow>("IndexRow")({
  name: Schema.String,
  size: Schema.Number,
  contentType: Schema.String,
  objectKey: Schema.String,
  createdAt: Schema.Union([Schema.Date, Schema.String])
}) {}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(IndexRow));

const toFile = (row: IndexRow): StoredFile => ({
  name: row.name,
  size: row.size,
  contentType: row.contentType,
  createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
});

const checkName = (name: string) =>
  name.length === 0 || name.length > 255 || /[/\\\0-\x1f]/.test(name)
    ? Effect.fail(new InvalidFileName({ name }))
    : Effect.void;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const content = yield* ContentStore.ContentStore;
  const index = (namespace: string) => `"${namespace}"."${FILES_INDEX}"`;
  const objectKey = (namespace: string, store: string, name: string) =>
    `primitives/${namespace}/${store}/${encodeURIComponent(name)}`;
  const SELECT = `"name", "size", "content_type" AS "contentType", "object_key" AS "objectKey", "created_at" AS "createdAt"`;

  const find = (namespace: string, store: string, name: string) =>
    sql
      .unsafe(`SELECT ${SELECT} FROM ${index(namespace)} WHERE "store" = $1 AND "name" = $2`, [
        store,
        name
      ])
      .pipe(
        Effect.flatMap(decodeRows),
        Effect.orDie,
        Effect.map((rows) => Option.fromNullishOr(rows[0]))
      );

  const put = Effect.fn("Files.put")(function* (
    namespace: string,
    store: string,
    name: string,
    bytes: Uint8Array,
    contentType: string
  ) {
    yield* checkName(name);
    const key = objectKey(namespace, store, name);
    yield* content.put(key, Encoding.encodeBase64(bytes));
    const rows = yield* sql
      .unsafe(
        `INSERT INTO ${index(namespace)} ("store", "name", "size", "content_type", "object_key") VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("store", "name") DO UPDATE SET "size" = EXCLUDED."size", "content_type" = EXCLUDED."content_type", "created_at" = now()
         RETURNING ${SELECT}`,
        [store, name, bytes.byteLength, contentType, key]
      )
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
    return toFile(rows[0]!);
  });

  const get = Effect.fn("Files.get")(function* (namespace: string, store: string, name: string) {
    const row = yield* find(namespace, store, name);
    if (Option.isNone(row)) return yield* new FileNotFound({ store, name });
    const encoded = yield* content
      .get(row.value.objectKey)
      .pipe(Effect.catchTags({ ObjectNotFound: () => new FileNotFound({ store, name }) }));
    const bytes = yield* Result.match(Encoding.decodeBase64(encoded), {
      onSuccess: Effect.succeed,
      onFailure: Effect.die
    });
    return { bytes, file: toFile(row.value) };
  });

  const list = Effect.fn("Files.list")(function* (namespace: string, store: string) {
    const rows = yield* sql
      .unsafe(
        `SELECT ${SELECT} FROM ${index(namespace)} WHERE "store" = $1 ORDER BY "created_at" DESC LIMIT 1000`,
        [store]
      )
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
    return rows.map(toFile);
  });

  const remove = Effect.fn("Files.delete")(function* (
    namespace: string,
    store: string,
    name: string
  ) {
    const row = yield* find(namespace, store, name);
    if (Option.isNone(row)) return;
    yield* sql.unsafe(`DELETE FROM ${index(namespace)} WHERE "store" = $1 AND "name" = $2`, [
      store,
      name
    ]);
    yield* content.delete(row.value.objectKey);
  });

  return Files.of({ put, get, list, delete: remove });
});

/** Over any `SqlClient` and `ContentStore`. */
export const layer = Layer.effect(Files, make);
