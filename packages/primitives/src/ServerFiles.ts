// PROTOTYPE for #315: tier 2 files (#303), reached only through the callback host and the two
// shell-level exceptions.
//
// - `serverFiles.*` and `sharedFiles.*` are callback operations: ServerCall resolves a guest's
//   `ctx.files.<store>` and `ctx.shared.<alias>` calls to them under the invocation's binding and
//   gates them per handler kind. They are never runtime operations, so a page cannot name them.
// - Every entry they return carries an authorised file handle minted for the binding: the
//   viewer, company, consuming patch, loaded version and exact stored object. The source store
//   is implied by the object, which is referenced by exactly one (patch, store, name) while it
//   is current. A handle is `fh_` + base64url(object id suffix, 16-byte MAC): fixed length, no
//   file name, deterministic for its tuple.
// - `files.redeem` (GET, not logged) re-authorises every redemption live: the MAC must match
//   the redeeming viewer and document, the name's pointer must still equal the object
//   (`not_found` otherwise), and the object's store must be one the loaded version defines or a
//   declared shared store the viewer can open now (`access_denied` otherwise).
// - `files.stage` (PUT, not logged) writes an unreferenced object and records a single-use
//   upload bound to the viewer, patch and loaded version. Adoption by `serverFiles.put` is a
//   pointer write under the name's file lock; the upload token, never an object id, is the
//   authority.
// Object keys are `files/<patchId>/<objectId>` (#303 point 8). The orphan sweep only reclaims
// the older four-segment keys, so unadopted staged objects are never swept here (stated gap).
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DefinitionName,
  FileContentType,
  FileName,
  FILE_HANDLE_PATTERN,
  UPLOAD_TOKEN_PATTERN,
  sharedStoreId
} from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { ContentStore } from "@patchy/content-store";
import { newInternalId } from "@patchy/core";
import { Binding, LoadedVersions, Runtime } from "@patchy/runtime/core";
import { boundedRows } from "./bounded-rows.js";

export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  subject: Schema.Literals(["file", "upload"])
}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return this.subject === "file"
      ? "This file was replaced or deleted since its handle was minted."
      : "No staged upload with this token is waiting for this viewer and document.";
  }
}
export class FileBusy extends Schema.TaggedError<FileBusy>()("ServerFileBusy", {
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
  defaultPage: Config.Int("PATCHY_FILE_DEFAULT_PAGE").pipe(Config.withDefault(100)),
  maxPage: Config.Int("PATCHY_FILE_MAX_PAGE").pipe(Config.withDefault(1000)),
  /** The handle MAC key; derived from the credential keyring when unset, random in dev. */
  handleKey: Config.option(Config.Redacted("PATCHY_FILE_HANDLE_KEY")),
  credentialKeys: Config.option(Config.Redacted("PATCHY_CREDENTIAL_KEYS"))
});

/** What `ctx.files.<store>.list/stat` and `ctx.shared.<alias>.list/stat` return per file. */
export const FileEntry = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  contentType: Schema.String,
  updatedAt: Schema.String,
  handle: Schema.String
});
const FileEntryPage = Schema.Struct({
  files: Schema.Array(FileEntry),
  cursor: Schema.NullOr(Schema.String)
});
const ListArgs = {
  prefix: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  cursor: Schema.optionalKey(Schema.String)
};
const OwnList = Schema.Struct({ store: DefinitionName, ...ListArgs });
const SharedList = Schema.Struct({ alias: DefinitionName, ...ListArgs });
const OwnName = Schema.Struct({ store: DefinitionName, name: FileName });
const SharedName = Schema.Struct({ alias: DefinitionName, name: FileName });
const Put = Schema.Struct({
  store: DefinitionName,
  name: FileName,
  contentType: Schema.optionalKey(FileContentType),
  /** Plain bytes an action generated, base64 over the callback. */
  bytes: Schema.optionalKey(Schema.String),
  /** A staged upload's token; the host's record supplies its size and claimed type. */
  upload: Schema.optionalKey(Schema.String)
});
const Content = Schema.NullOr(Schema.Struct({ entry: FileEntry, bytes: Schema.String }));

const Cursor = Schema.Struct({
  source: Schema.String,
  store: Schema.String,
  prefix: Schema.String,
  after: Schema.String
});
const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));
const FileRow = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  contentType: Schema.String,
  updatedAt: Schema.String,
  objectId: Schema.String
});
const decodeRows = Schema.decodeUnknownSync(Schema.Array(FileRow));
type FileRow = typeof FileRow.Type;

export const objectKey = (patchId: string, objectId: string) => `files/${patchId}/${objectId}`;
const isContentType = Schema.is(FileContentType);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const selectColumns = `name, size::float8 AS size, content_type AS "contentType",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
  object_id AS "objectId"`;

/** A store the binding may read: its own (defined by the loaded version) or a declared share. */
interface Source {
  readonly patchId: string;
  readonly store: string;
}

export const make = Effect.gen(function* () {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const content = yield* ContentStore.ContentStore;
  const versions = yield* LoadedVersions.LoadedVersions;
  const inventory = yield* Inventory.Inventory;
  const settings = yield* config;
  const key = Option.isSome(settings.handleKey)
    ? createHash("sha256").update(Redacted.value(settings.handleKey.value)).digest()
    : Option.isSome(settings.credentialKeys)
      ? createHash("sha256")
          .update(`patchy-file-handles:${Redacted.value(settings.credentialKeys.value)}`)
          .digest()
      : randomBytes(32);

  const mac = (binding: Binding.Binding["Service"], objectId: string) =>
    createHmac("sha256", key)
      .update(
        JSON.stringify([
          binding.identity?.user.id ?? null,
          binding.companyId,
          binding.patchId,
          binding.versionId,
          objectId
        ])
      )
      .digest()
      .subarray(0, 16);
  /** Deterministic for (viewer, company, consuming patch, loaded version, object). */
  const mint = (binding: Binding.Binding["Service"], objectId: string) =>
    `fh_${Buffer.concat([Buffer.from(objectId.slice(4), "latin1"), mac(binding, objectId)]).toString("base64url")}`;
  /** The object a handle names, if its MAC matches this binding; never trusts the guest. */
  const verify = (binding: Binding.Binding["Service"], handle: string): string | undefined => {
    if (!FILE_HANDLE_PATTERN.test(handle)) return undefined;
    const raw = Buffer.from(handle.slice(3), "base64url");
    if (raw.length !== 40) return undefined;
    const objectId = `obj_${raw.subarray(0, 24).toString("latin1")}`;
    if (!/^obj_[a-z0-9]{24}$/.test(objectId)) return undefined;
    return timingSafeEqual(raw.subarray(24), mac(binding, objectId)) ? objectId : undefined;
  };
  const entryOf = (binding: Binding.Binding["Service"], row: FileRow) => ({
    name: row.name,
    size: row.size,
    contentType: row.contentType,
    updatedAt: row.updatedAt,
    handle: mint(binding, row.objectId)
  });

  const withCompany = <A, R>(
    companyId: string,
    effect: Effect.Effect<A, Runtime.RuntimeError | SqlError, R>
  ) =>
    databases
      .withCompany(companyId)(effect)
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          Busy: (cause) => Effect.fail(new FileBusy({ limit: cause.limit, cause })),
          CompanyDatabaseError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          CompanyDatabaseNotReady: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          CompanyIdentityMismatch: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
        })
      );
  const query = (sql: SqlClient.SqlClient, text: string, values: ReadonlyArray<unknown>) =>
    sql.unsafe(text, values).pipe(Effect.map((rows) => decodeRows(rows)));

  const own = Effect.fn("ServerFiles.own")(function* (store: string) {
    const binding = yield* Binding.Binding;
    if (binding.manifest.tier !== 2 || !Object.hasOwn(binding.manifest.files, store))
      return yield* new Runtime.InvalidRequest({
        cause: new Error(`File store ${store} is not defined by this version.`)
      });
    return { binding, source: { patchId: binding.patchId, store } satisfies Source };
  });
  /**
   * A declared shared store, re-checked live on every read (#303 point 2): the source is live in
   * the viewer's company and still shares the store. This is distinct from the revision stamp,
   * which only warns at publish.
   */
  const liveShare = Effect.fn("ServerFiles.liveShare")(function* (
    binding: Binding.Binding["Service"],
    patchId: string,
    store: string
  ) {
    if (binding.identity === null || binding.identity.company.id !== binding.companyId)
      return yield* new Runtime.AccessDenied({});
    const source = yield* versions
      .find(patchId)
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    if (Option.isNone(source) || source.value.companyId !== binding.companyId)
      return yield* new Runtime.AccessDenied({});
    const snapshot = yield* withCompany(binding.companyId, inventory.read(patchId));
    if (snapshot?.stores.some((entry) => entry.name === store && entry.shared) !== true)
      return yield* new Runtime.AccessDenied({});
  });
  const shared = Effect.fn("ServerFiles.shared")(function* (alias: string) {
    const binding = yield* Binding.Binding;
    const declaration = Object.hasOwn(binding.manifest.uses, alias)
      ? binding.manifest.uses[alias]
      : undefined;
    if (declaration?.kind !== "sharedStore")
      return yield* new Runtime.InvalidRequest({
        cause: new Error(`${alias} is not a declared shared store.`)
      });
    if (declaration.id !== sharedStoreId(declaration.patchId, declaration.store))
      return yield* new Runtime.AccessDenied({});
    yield* liveShare(binding, declaration.patchId, declaration.store);
    return {
      binding,
      source: { patchId: declaration.patchId, store: declaration.store } satisfies Source
    };
  });

  const listPage = Effect.fn("ServerFiles.list")(function* (
    binding: Binding.Binding["Service"],
    source: Source,
    args: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string }
  ) {
    const limit = args.limit ?? settings.defaultPage;
    if (limit > settings.maxPage)
      return yield* new Runtime.InvalidRequest({
        cause: new Error(`limit is at most ${settings.maxPage}`)
      });
    const prefix = args.prefix ?? "";
    let after = "";
    if (args.cursor !== undefined) {
      const cursor = decodeCursor(Buffer.from(args.cursor, "base64url").toString("utf8"));
      if (
        Option.isNone(cursor) ||
        cursor.value.source !== source.patchId ||
        cursor.value.store !== source.store ||
        cursor.value.prefix !== prefix
      )
        return yield* new Runtime.InvalidRequest({ cause: new Error("invalid cursor") });
      after = cursor.value.after;
    }
    return yield* withCompany(
      binding.companyId,
      Effect.gen(function* () {
        const sql = yield* CompanyDatabases.CompanyConnection;
        const { rows, hasMore } = yield* boundedRows(
          sql,
          `SELECT *, row_number() OVER (ORDER BY name COLLATE "C") AS "__position" FROM (
            SELECT ${selectColumns} FROM patchy.files
            WHERE patch_id = $1 AND store = $2 AND starts_with(name, $3)
              AND name COLLATE "C" > $4 COLLATE "C"
            ORDER BY name COLLATE "C" LIMIT $5) AS selected`,
          [source.patchId, source.store, prefix, after, limit + 1],
          limit,
          settings.resultBytes
        );
        const files = decodeRows(rows).map((row) => entryOf(binding, row));
        const last = files[files.length - 1];
        return {
          files,
          cursor:
            hasMore && last !== undefined
              ? Buffer.from(
                  encodeCursor({
                    source: source.patchId,
                    store: source.store,
                    prefix,
                    after: last.name
                  })
                ).toString("base64url")
              : null
        };
      })
    );
  });
  const findRow = (companyId: string, source: Source, name: string) =>
    withCompany(
      companyId,
      Effect.gen(function* () {
        const sql = yield* CompanyDatabases.CompanyConnection;
        const rows = yield* query(
          sql,
          `SELECT ${selectColumns} FROM patchy.files WHERE patch_id = $1 AND store = $2 AND name = $3`,
          [source.patchId, source.store, name]
        );
        return rows[0];
      })
    );
  const readBytes = (patchId: string, objectId: string) =>
    content
      .getBytes(objectKey(patchId, objectId))
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
  const contentOf = Effect.fn("ServerFiles.content")(function* (
    binding: Binding.Binding["Service"],
    source: Source,
    name: string
  ) {
    const row = yield* findRow(binding.companyId, source, name);
    if (row === undefined) return null;
    const bytes = yield* readBytes(source.patchId, row.objectId);
    return { entry: entryOf(binding, row), bytes: Buffer.from(bytes).toString("base64") };
  });
  /** The pointer write, under the name's lock, so a replaced name never points at two objects. */
  const writePointer = <A>(
    binding: Binding.Binding["Service"],
    store: string,
    name: string,
    run: (sql: SqlClient.SqlClient) => Effect.Effect<A, Runtime.RuntimeError | SqlError>
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
          return yield* run(lock.sql);
        })
      )
    );

  const callbacks = {
    "serverFiles.list": Runtime.handler(
      { kind: "read", input: OwnList, output: FileEntryPage },
      (args) =>
        Effect.flatMap(own(args.store), ({ binding, source }) => listPage(binding, source, args))
    ),
    "serverFiles.stat": Runtime.handler(
      { kind: "read", input: OwnName, output: Schema.NullOr(FileEntry) },
      (args) =>
        Effect.gen(function* () {
          const { binding, source } = yield* own(args.store);
          const row = yield* findRow(binding.companyId, source, args.name);
          return row === undefined ? null : entryOf(binding, row);
        })
    ),
    "serverFiles.get": Runtime.handler({ kind: "read", input: OwnName, output: Content }, (args) =>
      Effect.flatMap(own(args.store), ({ binding, source }) =>
        contentOf(binding, source, args.name)
      )
    ),
    "serverFiles.put": Runtime.handler(
      { kind: "mutation", input: Put, output: FileEntry },
      (args) =>
        Effect.gen(function* () {
          const { binding } = yield* own(args.store);
          if ((args.bytes === undefined) === (args.upload === undefined))
            return yield* new Runtime.InvalidRequest({
              cause: new Error("put takes either bytes or an Upload")
            });
          const upsert = (
            sql: SqlClient.SqlClient,
            objectId: string,
            size: number,
            contentType: string,
            sha256: string
          ) =>
            query(
              sql,
              `INSERT INTO patchy.files (patch_id, store, name, object_id, size, content_type, sha256)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (patch_id, store, name) DO UPDATE SET
                 object_id = EXCLUDED.object_id, size = EXCLUDED.size,
                 content_type = EXCLUDED.content_type, sha256 = EXCLUDED.sha256,
                 updated_at = clock_timestamp()
               RETURNING ${selectColumns}`,
              [binding.patchId, args.store, args.name, objectId, size, contentType, sha256]
            );
          if (args.upload !== undefined) {
            const token = args.upload;
            if (!UPLOAD_TOKEN_PATTERN.test(token))
              return yield* new FileNotFound({ subject: "upload" });
            // Adoption: the token is consumed and the name points at the staged object, in one
            // transaction under the name's lock. No bytes move.
            const rows = yield* writePointer(binding, args.store, args.name, (sql) =>
              Effect.gen(function* () {
                const adopted = yield* sql.unsafe<{
                  objectId: string;
                  size: number;
                  contentType: string;
                  sha256: string;
                }>(
                  `UPDATE patchy.uploads SET adopted_at = clock_timestamp()
                   WHERE token_hash = $1 AND patch_id = $2 AND version_id = $3 AND user_id = $4
                     AND adopted_at IS NULL
                   RETURNING object_id AS "objectId", size::float8 AS size,
                     content_type AS "contentType", sha256`,
                  [
                    tokenHash(token),
                    binding.patchId,
                    binding.versionId,
                    binding.identity?.user.id ?? ""
                  ]
                );
                const upload = adopted[0];
                if (upload === undefined) return yield* new FileNotFound({ subject: "upload" });
                return yield* upsert(
                  sql,
                  upload.objectId,
                  upload.size,
                  args.contentType ?? upload.contentType,
                  upload.sha256
                );
              })
            );
            return entryOf(binding, rows[0]!);
          }
          if (args.contentType === undefined)
            return yield* new Runtime.InvalidRequest({
              cause: new Error("put(name, bytes) needs { contentType }")
            });
          const bytes = Buffer.from(args.bytes!, "base64");
          if (bytes.byteLength > settings.fileBytes)
            return yield* new Runtime.TooLarge({ maxBytes: settings.fileBytes });
          const objectId = newInternalId("obj");
          // Unique immutable objects need no lock; only the later pointer change does.
          yield* content
            .putBytes(objectKey(binding.patchId, objectId), bytes)
            .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
          const rows = yield* writePointer(binding, args.store, args.name, (sql) =>
            upsert(
              sql,
              objectId,
              bytes.byteLength,
              args.contentType!,
              createHash("sha256").update(bytes).digest("hex")
            )
          );
          return entryOf(binding, rows[0]!);
        })
    ),
    "serverFiles.delete": Runtime.handler(
      { kind: "mutation", input: OwnName, output: Schema.Boolean },
      (args) =>
        Effect.gen(function* () {
          const { binding } = yield* own(args.store);
          const removed = yield* writePointer(binding, args.store, args.name, (sql) =>
            sql.unsafe(
              `DELETE FROM patchy.files WHERE patch_id = $1 AND store = $2 AND name = $3 RETURNING name`,
              [binding.patchId, args.store, args.name]
            )
          );
          return removed.length > 0;
        })
    ),
    "sharedFiles.list": Runtime.handler(
      { kind: "read", input: SharedList, output: FileEntryPage },
      (args) =>
        Effect.flatMap(shared(args.alias), ({ binding, source }) => listPage(binding, source, args))
    ),
    "sharedFiles.stat": Runtime.handler(
      { kind: "read", input: SharedName, output: Schema.NullOr(FileEntry) },
      (args) =>
        Effect.gen(function* () {
          const { binding, source } = yield* shared(args.alias);
          const row = yield* findRow(binding.companyId, source, args.name);
          return row === undefined ? null : entryOf(binding, row);
        })
    ),
    "sharedFiles.get": Runtime.handler(
      { kind: "read", input: SharedName, output: Content },
      (args) =>
        Effect.flatMap(shared(args.alias), ({ binding, source }) =>
          contentOf(binding, source, args.name)
        )
    )
  } satisfies Readonly<Record<string, Runtime.Handler>>;

  /** The bytes of one handle, for the shell; re-authorised on every call, cache hits included. */
  const redeem = {
    kind: "read",
    transport: "bytes-get",
    run: (input: unknown) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const args = (input ?? {}) as { handle?: unknown; ifNoneMatch?: unknown };
        const objectId = typeof args.handle === "string" ? verify(binding, args.handle) : undefined;
        // Another viewer, another patch or version, or not a handle at all.
        if (objectId === undefined) return yield* new Runtime.AccessDenied({});
        const row = yield* withCompany(
          binding.companyId,
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            const rows = yield* sql.unsafe<{
              patchId: string;
              store: string;
              name: string;
              contentType: string;
            }>(
              `SELECT patch_id AS "patchId", store, name, content_type AS "contentType"
               FROM patchy.files WHERE object_id = $1`,
              [objectId]
            );
            return rows[0];
          })
        );
        // The name no longer points at these bytes: replaced or deleted.
        if (row === undefined) return yield* new FileNotFound({ subject: "file" });
        if (row.patchId === binding.patchId) {
          if (!Object.hasOwn(binding.manifest.files, row.store))
            return yield* new Runtime.AccessDenied({});
        } else {
          const declared = Object.values(binding.manifest.uses).some(
            (use) =>
              use.kind === "sharedStore" &&
              use.patchId === row.patchId &&
              use.store === row.store &&
              use.id === sharedStoreId(use.patchId, use.store)
          );
          if (!declared) return yield* new Runtime.AccessDenied({});
          yield* liveShare(binding, row.patchId, row.store);
        }
        if (args.ifNoneMatch === objectId)
          return {
            bytes: new Uint8Array(0),
            contentType: row.contentType,
            name: row.name,
            etag: objectId,
            notModified: true
          };
        const bytes = yield* readBytes(row.patchId, objectId);
        return { bytes, contentType: row.contentType, name: row.name, etag: objectId };
      })
  } satisfies Runtime.BytesGetHandler;

  /** Staging: an unreferenced object and a single-use upload for this viewer and document. */
  const stage = {
    kind: "read",
    transport: "bytes-put",
    run: (input: unknown, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const args = (input ?? {}) as { contentType?: unknown };
        if (
          binding.identity === null ||
          binding.manifest.tier !== 2 ||
          Object.keys(binding.manifest.files).length === 0
        )
          return yield* new Runtime.InvalidRequest({
            cause: new Error("Staging needs a tier 2 version that defines a file store.")
          });
        const contentType =
          typeof args.contentType === "string" && isContentType(args.contentType)
            ? args.contentType
            : "application/octet-stream";
        if (bytes.byteLength > settings.fileBytes)
          return yield* new Runtime.TooLarge({ maxBytes: settings.fileBytes });
        const objectId = newInternalId("obj");
        yield* content
          .putBytes(objectKey(binding.patchId, objectId), bytes)
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
        const token = `upl_${randomBytes(24).toString("base64url")}`;
        yield* withCompany(
          binding.companyId,
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            yield* sql.unsafe(
              `INSERT INTO patchy.uploads (token_hash, object_id, patch_id, version_id, user_id, size, content_type, sha256)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                tokenHash(token),
                objectId,
                binding.patchId,
                binding.versionId,
                binding.identity!.user.id,
                bytes.byteLength,
                contentType,
                createHash("sha256").update(bytes).digest("hex")
              ]
            );
          })
        );
        return { token, size: bytes.byteLength, contentType };
      })
  } satisfies Runtime.BytesPutHandler;

  /**
   * The authoritative size and claimed type of a staged upload the binding's viewer may adopt,
   * for ServerCall to substitute into an action's `t.upload()` arguments before invocation.
   */
  const resolveUpload = (binding: Binding.Binding["Service"], token: string) =>
    Effect.gen(function* () {
      if (!UPLOAD_TOKEN_PATTERN.test(token)) return yield* new FileNotFound({ subject: "upload" });
      const rows = yield* withCompany(
        binding.companyId,
        Effect.gen(function* () {
          const sql = yield* CompanyDatabases.CompanyConnection;
          return yield* sql.unsafe<{ size: number; contentType: string }>(
            `SELECT size::float8 AS size, content_type AS "contentType" FROM patchy.uploads
             WHERE token_hash = $1 AND patch_id = $2 AND version_id = $3 AND user_id = $4
               AND adopted_at IS NULL`,
            [tokenHash(token), binding.patchId, binding.versionId, binding.identity?.user.id ?? ""]
          );
        })
      );
      const upload = rows[0];
      if (upload === undefined) return yield* new FileNotFound({ subject: "upload" });
      return { token, size: upload.size, contentType: upload.contentType };
    });

  return {
    callbacks,
    routes: { "files.redeem": redeem, "files.stage": stage },
    resolveUpload
  };
});
