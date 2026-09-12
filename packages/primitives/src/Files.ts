import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DefinitionName,
  FileContentType,
  FileMetadata,
  FileName,
  runtimeOperations
} from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import { ContentStore } from "@patchy/content-store";
import { newInternalId } from "@patchy/core";
import { Binding, Runtime } from "@patchy/runtime/core";
import { boundedRows } from "./bounded-rows.js";

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("FileInvalidCursor", {
  store: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return `Invalid cursor for ${this.store}; use a cursor from the same patch, store and prefix.`;
  }
}
export class PageLimit extends Schema.TaggedError<PageLimit>()("FilePageLimit", {
  maxItems: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return `File list exceeds ${this.maxItems} items.`;
  }
}
export class Busy extends Schema.TaggedError<Busy>()("FileBusy", {
  limit: Schema.Int,
  cause: Schema.Defect()
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  override get message() {
    return `Company database capacity (${this.limit}) is exhausted. Try again shortly.`;
  }
}

export const config = Config.all({
  fileBytes: Runtime.byteLimits.fileBytes,
  resultBytes: Runtime.byteLimits.resultBytes,
  defaultPage: Config.int("PATCHY_FILE_DEFAULT_PAGE").pipe(Config.withDefault(100)),
  maxPage: Config.int("PATCHY_FILE_MAX_PAGE").pipe(Config.withDefault(1000))
});
const cursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  patchId: Schema.String,
  store: DefinitionName,
  prefix: Schema.String,
  after: FileName
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(cursorSchema), {
  onExcessProperty: "error"
});
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(cursorSchema));
const isName = Schema.is(FileName);
const isStore = Schema.is(DefinitionName);
const resource: Runtime.Handler["resource"] = (args) =>
  typeof args === "object" &&
  args !== null &&
  "store" in args &&
  isStore(args.store) &&
  "name" in args &&
  isName(args.name)
    ? `${args.store}/${args.name}`
    : null;
const objectKey = (patchId: string, store: string, objectId: string) =>
  `files/${patchId}/${store}/${objectId}`;
const decodePut = Schema.decodeUnknownEffect(runtimeOperations["files.put"].request.fields.args, {
  onExcessProperty: "error"
});
const decodeGet = Schema.decodeUnknownEffect(runtimeOperations["files.get"].request.fields.args, {
  onExcessProperty: "error"
});
const findFile = SqlSchema.findOneOption({
  Request: Schema.Struct({ patchId: Schema.String, store: DefinitionName, name: FileName }),
  Result: Schema.Struct({ objectId: Schema.String, contentType: FileContentType }),
  execute: ({ patchId, store, name }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`
      SELECT object_id AS "objectId", content_type AS "contentType"
      FROM patchy.files WHERE patch_id = ${patchId} AND store = ${store} AND name = ${name}`
    )
});
const decodeFiles = Schema.decodeUnknownSync(Schema.Array(FileMetadata));
const encodePage = Schema.encodeSync(
  Schema.fromJsonString(runtimeOperations["files.list"].response)
);

export const make = Effect.gen(function* () {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const content = yield* ContentStore.ContentStore;
  const settings = yield* config;
  const withCompany = <A, R>(
    companyId: string,
    effect: Effect.Effect<A, Runtime.RuntimeError | SqlError, R>
  ) =>
    databases
      .withCompany(companyId)(effect)
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          Busy: (cause) => Effect.fail(new Busy({ limit: cause.limit, cause })),
          CompanyDatabaseError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          CompanyDatabaseNotReady: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          CompanyIdentityMismatch: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
        })
      );
  const withStore = <A>(
    store: string,
    run: (binding: Binding.Binding["Service"]) => Effect.Effect<A, Runtime.RuntimeError>
  ) =>
    Effect.gen(function* () {
      const binding = yield* Binding.Binding;
      if (!Object.hasOwn(binding.manifest.files, store))
        return yield* new Runtime.InvalidRequest({});
      return yield* run(binding);
    });
  const withIndex = <A>(
    binding: Binding.Binding["Service"],
    store: string,
    name: string,
    run: (
      sql: SqlClient.SqlClient
    ) => Effect.Effect<A, Runtime.RuntimeError | SqlError, SqlClient.SqlClient>
  ) =>
    withCompany(
      binding.companyId,
      databases.withFileLock(
        binding.patchId,
        store,
        name
      )(
        Effect.gen(function* () {
          const lock = yield* CompanyDatabases.FileLock;
          if (lock.patchId !== binding.patchId || lock.store !== store || lock.name !== name)
            return yield* Effect.die(new Error("File index access requires a matching file lock"));
          return yield* run(lock.sql);
        })
      )
    );
  const put = {
    kind: "mutation",
    transport: "bytes-put",
    resource,
    run: (input: unknown, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const args = yield* decodePut(input).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        if (bytes.byteLength > settings.fileBytes)
          return yield* new Runtime.TooLarge({ maxBytes: settings.fileBytes });
        return yield* withStore(args.store, (binding) =>
          Effect.gen(function* () {
            const objectId = newInternalId("obj");
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            // Unique immutable objects need no lease or lock; only the later pointer change does.
            yield* content
              .putBytes(objectKey(binding.patchId, args.store, objectId), bytes)
              .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
            return yield* withIndex(binding, args.store, args.name, (sql) =>
              sql`INSERT INTO patchy.files (patch_id, store, name, object_id, size, content_type, sha256)
                VALUES (${binding.patchId}, ${args.store}, ${args.name}, ${objectId}, ${bytes.byteLength}, ${args.contentType}, ${sha256})
                ON CONFLICT (patch_id, store, name) DO UPDATE SET
                  object_id = EXCLUDED.object_id, size = EXCLUDED.size, content_type = EXCLUDED.content_type,
                  sha256 = EXCLUDED.sha256, updated_at = clock_timestamp()`.pipe(Effect.as(null))
            );
          })
        );
      })
  } satisfies Runtime.BytesPutHandler;
  const get = {
    kind: "read",
    transport: "bytes-get",
    run: (input: unknown) =>
      Effect.gen(function* () {
        const args = yield* decodeGet(input).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        return yield* withStore(args.store, (binding) =>
          Effect.gen(function* () {
            const row = yield* withIndex(binding, args.store, args.name, () =>
              findFile({ patchId: binding.patchId, ...args }).pipe(
                Effect.catchTags({ SchemaError: Effect.die })
              )
            );
            if (Option.isNone(row)) return yield* new Runtime.InvalidRequest({});
            const bytes = yield* content
              .getBytes(objectKey(binding.patchId, args.store, row.value.objectId))
              .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
            return { bytes, contentType: row.value.contentType };
          })
        );
      })
  } satisfies Runtime.BytesGetHandler;
  const list = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["files.list"].request.fields.args,
      output: runtimeOperations["files.list"].response
    },
    (args) =>
      withStore(args.store, (binding) =>
        withCompany(
          binding.companyId,
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            const patchId = binding.patchId;
            const limit = args.limit ?? settings.defaultPage;
            if (limit > settings.maxPage)
              return yield* new PageLimit({ maxItems: settings.maxPage });
            const prefix = args.prefix ?? "";
            let after = "";
            if (args.cursor !== undefined) {
              if (!/^[A-Za-z0-9_-]+$/.test(args.cursor))
                return yield* new InvalidCursor({ store: args.store });
              const cursor = yield* decodeCursor(
                Buffer.from(args.cursor, "base64url").toString("utf8")
              ).pipe(Effect.mapError((cause) => new InvalidCursor({ store: args.store, cause })));
              if (
                cursor.patchId !== patchId ||
                cursor.store !== args.store ||
                cursor.prefix !== prefix ||
                !cursor.after.startsWith(prefix)
              )
                return yield* new InvalidCursor({ store: args.store });
              after = cursor.after;
            }
            const { rows, hasMore } = yield* boundedRows(
              sql,
              `SELECT name, size, "contentType", "updatedAt",
              row_number() OVER (ORDER BY name COLLATE "C") AS "__position"
            FROM (
              SELECT name, size, content_type AS "contentType",
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
              FROM patchy.files WHERE patch_id = $1 AND store = $2
                AND starts_with(name, $3) AND name COLLATE "C" > $4 COLLATE "C"
              ORDER BY name COLLATE "C" LIMIT $5
            ) AS selected`,
              [patchId, args.store, prefix, after, limit + 1],
              limit,
              settings.resultBytes
            );
            const files = decodeFiles(rows);
            const last = files[files.length - 1];
            const result = {
              files,
              cursor:
                hasMore && last !== undefined
                  ? Buffer.from(
                      encodeCursor({
                        version: 1,
                        patchId,
                        store: args.store,
                        prefix,
                        after: last.name
                      })
                    ).toString("base64url")
                  : null
            };
            if (Buffer.byteLength(encodePage(result)) > settings.resultBytes)
              return yield* new Runtime.TooLarge({ maxBytes: settings.resultBytes });
            return result;
          })
        )
      )
  );
  const remove = Runtime.handler(
    {
      kind: "mutation",
      input: runtimeOperations["files.delete"].request.fields.args,
      output: runtimeOperations["files.delete"].response,
      resource
    },
    (args) =>
      withStore(args.store, (binding) =>
        withIndex(binding, args.store, args.name, (sql) =>
          sql`DELETE FROM patchy.files WHERE patch_id = ${binding.patchId} AND store = ${args.store} AND name = ${args.name}`.pipe(
            Effect.as(null)
          )
        )
      )
  );
  return {
    "files.put": put,
    "files.get": get,
    "files.list": list,
    "files.delete": remove
  } satisfies Readonly<Record<string, Runtime.Handler>>;
});
