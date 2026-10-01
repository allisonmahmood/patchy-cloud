import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
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
  runtimeOperations,
  sharedStoreId,
  type FileList,
  type SharedStoreDeclaration
} from "@patchy/api";
import { WideEvents } from "@patchy/analytics";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { ContentStore } from "@patchy/content-store";
import { newInternalId } from "@patchy/core";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { Binding, LoadedVersions, Runtime, Wakes } from "@patchy/runtime/core";
import { boundedRows } from "./bounded-rows.js";
import * as ReadSnapshot from "./ReadSnapshot.js";

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
  ...CompanyDatabases.Busy.fields,
  cause: Schema.Defect()
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  override get message() {
    return `Company database capacity (${this.value}) is exhausted. Try again shortly.`;
  }
}
class NotFound extends Schema.TaggedError<NotFound>()("FileNotFound", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "The selected file no longer exists.";
  }
}
class UploadNotFound extends Schema.TaggedError<UploadNotFound>()("UploadNotFound", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "The selected upload no longer exists.";
  }
}
class ReservationExpired extends Schema.TaggedError<ReservationExpired>()(
  "FileReservationExpired",
  {}
) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "The file upload reservation has expired.";
  }
}

export const config = Effect.all({
  fileBytes: Runtime.byteLimits.fileBytes,
  resultBytes: Runtime.byteLimits.resultBytes,
  defaultPage: Config.Int("PATCHY_FILE_DEFAULT_PAGE").pipe(Config.withDefault(100)),
  maxPage: Config.Int("PATCHY_FILE_MAX_PAGE").pipe(Config.withDefault(1000))
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
const objectKey = (patchId: string, objectId: string) => `files/${patchId}/${objectId}`;
const decodePut = Schema.decodeUnknownEffect(runtimeOperations["files.put"].request.fields.args, {
  onExcessProperty: "error"
});
const decodeStage = Schema.decodeUnknownEffect(
  runtimeOperations["files.stage"].request.fields.args,
  {
    onExcessProperty: "error"
  }
);
const decodeGet = Schema.decodeUnknownEffect(runtimeOperations["files.get"].request.fields.args, {
  onExcessProperty: "error"
});
const decodeSharedGet = Schema.decodeUnknownEffect(
  runtimeOperations["shared.files.get"].request.fields.args,
  { onExcessProperty: "error" }
);
const decodeRedeem = Schema.decodeUnknownEffect(
  runtimeOperations["files.redeem"].request.fields.args,
  {
    onExcessProperty: "error"
  }
);
const handleKey = SqlSchema.findOne({
  Request: Schema.Void,
  Result: Schema.Struct({ secret: Schema.String }),
  execute: () =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`SELECT secret FROM patchy.file_handle_key WHERE singleton = true`
    )
})(undefined).pipe(
  Effect.map(({ secret }) => Buffer.from(secret, "hex")),
  Effect.catchTags({
    SchemaError: Effect.die,
    NoSuchElementError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
  })
);
const findObject = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: Schema.Struct({
    patchId: Schema.String,
    store: DefinitionName,
    name: FileName,
    objectId: Schema.String,
    contentType: FileContentType
  }),
  execute: (objectId) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT patch_id AS "patchId", store, name, object_id AS "objectId",
        content_type AS "contentType" FROM patchy.files WHERE object_id = ${objectId}`
    )
});
const encodeHandleBinding = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String)))
);
// The company-wide unique object locator commits its immutable source patch/store too.
const handleMac = (secret: Uint8Array, binding: Binding.Binding["Service"], locator: string) =>
  createHmac("sha256", secret)
    .update(
      encodeHandleBinding([
        "patchy-file-handle-1",
        binding.companyId,
        binding.identity?.user.id ?? null,
        binding.patchId,
        binding.versionId,
        locator
      ])
    )
    .digest()
    .subarray(0, 24)
    .toString("base64url");
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
const decodeFileRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ ...FileMetadata.fields, objectId: Schema.String }))
);
const encodePage = Schema.encodeSync(
  Schema.fromJsonString(runtimeOperations["files.list"].response)
);
type StoreOwner = Pick<Binding.Binding["Service"], "companyId" | "patchId">;
const uploadRow = Schema.Struct({
  objectId: Schema.String,
  size: Schema.Number,
  contentType: FileContentType,
  sha256: Schema.String
});
type UploadRow = typeof uploadRow.Type;
const decodeUploadRows = Schema.decodeUnknownSync(Schema.Array(uploadRow));

const makeWithCompanyQuota = Effect.fn("Files.make")(function* (
  companyQuota: (
    companyId: string
  ) => Effect.Effect<
    Pick<OperatingLimits.EffectiveLimit, "value" | "configRevision">,
    Runtime.RuntimeError
  >
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;
  const versions = yield* LoadedVersions.LoadedVersions;
  const content = yield* ContentStore.ContentStore;
  const settings = yield* config;
  const wakes = yield* Wakes.Wakes;
  const stageLimits = yield* Effect.all({
    bytes: ContractLimits.get("files.stage.bytes"),
    count: ContractLimits.get("files.stage.count"),
    viewerBytes: ContractLimits.get("files.stage.viewerBytes"),
    lifetime: ContractLimits.get("files.stage.lifetime")
  });
  const withCompany = <A, R>(
    companyId: string,
    effect: Effect.Effect<A, Runtime.RuntimeError | ReservationExpired | SqlError, R>
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.serviceOption(ReadSnapshot.ReadSnapshot);
      if (Option.isSome(snapshot) && snapshot.value.companyId === companyId)
        return yield* effect.pipe(
          Effect.provideService(CompanyDatabases.CompanyConnection, snapshot.value.sql),
          Effect.provideService(SqlClient.SqlClient, snapshot.value.sql)
        );
      return yield* databases.withCompany(companyId)(effect);
    }).pipe(
      Effect.catchTags({
        SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
        Busy: (cause) =>
          Effect.fail(
            new Busy({
              resource: cause.resource,
              scope: cause.scope,
              limitId: cause.limitId,
              value: cause.value,
              retryAfterSeconds: cause.retryAfterSeconds,
              cause
            })
          ),
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
  const sharedSourceAccess = Effect.fn("Files.sharedSourceAccess")(function* (
    binding: Binding.Binding["Service"],
    declaration: typeof SharedStoreDeclaration.Type
  ) {
    if (
      declaration.id !== sharedStoreId(declaration.patchId, declaration.store) ||
      binding.identity === null ||
      binding.identity.company.id !== binding.companyId
    )
      return yield* new Runtime.AccessDenied({});
    const source = yield* versions
      .find(declaration.patchId)
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    if (Option.isNone(source) || source.value.companyId !== binding.companyId)
      return yield* new Runtime.AccessDenied({});
    yield* withCompany(
      binding.companyId,
      Effect.gen(function* () {
        const retained = yield* Effect.serviceOption(ReadSnapshot.ReadSnapshot);
        const snapshot =
          Option.isSome(retained) && retained.value.authority !== undefined
            ? yield* retained.value.authority(declaration.patchId)
            : yield* inventory.read(declaration.patchId);
        if (
          snapshot === null ||
          !snapshot.stores.some((store) => store.name === declaration.store && store.shared)
        )
          return yield* new Runtime.AccessDenied({});
      })
    );
  });
  const withSharedStore = Effect.fn("Files.withSharedStore")(function* <A>(
    alias: string,
    run: (
      owner: StoreOwner,
      store: string,
      consumer: Binding.Binding["Service"]
    ) => Effect.Effect<A, Runtime.RuntimeError>
  ) {
    const binding = yield* Binding.Binding;
    const declaration = Object.hasOwn(binding.manifest.uses, alias)
      ? binding.manifest.uses[alias]
      : undefined;
    if (declaration?.kind !== "sharedStore") return yield* new Runtime.InvalidRequest({});
    yield* sharedSourceAccess(binding, declaration);
    return yield* run(
      { companyId: binding.companyId, patchId: declaration.patchId },
      declaration.store,
      binding
    );
  });
  const withIndex = <A>(
    binding: StoreOwner,
    store: string,
    name: string,
    run: (
      sql: SqlClient.SqlClient
    ) => Effect.Effect<
      A,
      Runtime.RuntimeError | ReservationExpired | SqlError,
      SqlClient.SqlClient | CompanyDatabases.CompanyConnection
    >
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
  const withWriteIndex = <A>(
    binding: Binding.Binding["Service"],
    store: string,
    name: string,
    run: (
      sql: SqlClient.SqlClient
    ) => Effect.Effect<
      A,
      Runtime.RuntimeError | ReservationExpired | SqlError,
      SqlClient.SqlClient | CompanyDatabases.CompanyConnection
    >
  ) =>
    Effect.gen(function* () {
      const result = yield* withIndex(binding, store, name, (sql) =>
        Effect.gen(function* () {
          const result = yield* run(sql);
          yield* sql`UPDATE patchy.stores SET resource_revision = resource_revision + 1
            WHERE patch_id = ${binding.patchId} AND name = ${store}`;
          return result;
        })
      );
      yield* wakes.publish([`store:${binding.patchId}:${store}`]);
      return result;
    });
  const uploadBinding = Effect.gen(function* () {
    const binding = yield* Binding.Binding;
    if (
      binding.manifest.tier !== 2 ||
      binding.identity === null ||
      binding.identity.company.id !== binding.companyId
    )
      return yield* new Runtime.AccessDenied({});
    return binding;
  });
  const reserveUpload = Effect.fn("Files.reserveUpload")(function* (
    binding: Binding.Binding["Service"],
    bytes: Uint8Array,
    contentType: string
  ) {
    const companyBytes = yield* companyQuota(binding.companyId);
    yield* databases.ensureReady(binding.companyId).pipe(
      Effect.mapError((cause) =>
        cause._tag === "Busy"
          ? new Busy({
              resource: cause.resource,
              scope: cause.scope,
              limitId: cause.limitId,
              value: cause.value,
              retryAfterSeconds: cause.retryAfterSeconds,
              cause
            })
          : new Runtime.SourceUnavailable({ cause })
      )
    );
    const row = {
      objectId: newInternalId("obj"),
      token: randomBytes(32).toString("base64url"),
      size: bytes.byteLength,
      contentType,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
    yield* withCompany(
      binding.companyId,
      CompanyDatabases.withFileObjectsLock(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const now = DateTime.formatIso(yield* DateTime.now);
          // Reservations count before blob I/O, including writers on other replicas.
          const [usage] = yield* sql<{
            count: number;
            viewerBytes: number;
            companyBytes: number;
          }>`SELECT
            count(*) FILTER (WHERE patch_id = ${binding.patchId} AND viewer_id = ${binding.identity!.user.id})::integer AS count,
            coalesce(sum(size) FILTER (WHERE patch_id = ${binding.patchId} AND viewer_id = ${binding.identity!.user.id}), 0)::double precision AS "viewerBytes",
            coalesce(sum(size), 0)::double precision AS "companyBytes"
            FROM patchy.file_uploads
            WHERE token IS NOT NULL AND state IN ('writing', 'staged') AND expires_at > ${now}::timestamptz`;
          const contractRevision = { deploymentRevision: "contract", overrideRevision: "0" };
          const limits = [
            {
              limitId: "files.stage.count",
              value: stageLimits.count,
              peak: usage!.count + 1,
              configRevision: contractRevision
            },
            {
              limitId: "files.stage.viewerBytes",
              value: stageLimits.viewerBytes,
              peak: usage!.viewerBytes + row.size,
              configRevision: contractRevision
            },
            {
              limitId: "files.stage.companyBytes",
              value: companyBytes.value,
              peak: usage!.companyBytes + row.size,
              configRevision: companyBytes.configRevision
            }
          ] as const;
          yield* WideEvents.enrich({ limits });
          for (const { limitId, value, peak } of limits)
            if (peak > value) return yield* new Runtime.LimitExceeded({ limitId, value });
          yield* sql`INSERT INTO patchy.file_uploads
            (object_id, patch_id, token, viewer_id, version_id, size, content_type, sha256, expires_at, state)
            VALUES (${row.objectId}, ${binding.patchId}, ${row.token},
              ${binding.identity!.user.id}, ${binding.versionId},
              ${row.size}, ${row.contentType}, ${row.sha256},
              ${now}::timestamptz + ${stageLimits.lifetime} * interval '1 millisecond', 'writing')`;
        })
      )
    );
    yield* content.putBytes(objectKey(binding.patchId, row.objectId), bytes).pipe(
      Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })),
      Effect.onError(() =>
        withCompany(
          binding.companyId,
          CompanyDatabases.withFileObjectsLock(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`UPDATE patchy.file_uploads SET state = 'discarded'
                WHERE object_id = ${row.objectId} AND state = 'writing'`
            )
          )
        ).pipe(Effect.catch(() => Effect.void))
      )
    );
    return row;
  });
  const finishStage = Effect.fn("Files.finishStage")(function* (objectId: string) {
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql`UPDATE patchy.file_uploads SET state = 'staged'
      WHERE object_id = ${objectId} AND state = 'writing' AND expires_at > ${now}::timestamptz
      RETURNING object_id`;
    if (rows.length === 0) return yield* new ReservationExpired();
  });
  const selectedUpload = Effect.fn("Files.selectedUpload")(function* (
    binding: Binding.Binding["Service"],
    token: string
  ) {
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = decodeUploadRows(
      yield* sql`SELECT object_id AS "objectId", size::double precision AS size,
      content_type AS "contentType", sha256 FROM patchy.file_uploads
      WHERE token = ${token} AND patch_id = ${binding.patchId}
        AND viewer_id = ${binding.identity!.user.id} AND version_id = ${binding.versionId}
        AND state = 'staged' AND expires_at > ${now}::timestamptz FOR UPDATE`
    );
    if (rows.length === 0) return yield* new UploadNotFound();
    return rows[0]!;
  });
  const indexObject = Effect.fn("Files.indexObject")(function* (
    binding: StoreOwner,
    store: string,
    name: string,
    row: UploadRow
  ) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO patchy.files (patch_id, store, name, object_id, size, content_type, sha256)
      VALUES (${binding.patchId}, ${store}, ${name}, ${row.objectId}, ${row.size}, ${row.contentType}, ${row.sha256})
      ON CONFLICT (patch_id, store, name) DO UPDATE SET
        object_id = EXCLUDED.object_id, size = EXCLUDED.size, content_type = EXCLUDED.content_type,
        sha256 = EXCLUDED.sha256, updated_at = clock_timestamp()`;
    return null;
  });
  const removeDiscardedObject = Effect.fn("Files.removeDiscardedObject")(function* (
    binding: StoreOwner,
    objectId: string
  ) {
    yield* content
      .delete(objectKey(binding.patchId, objectId))
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    yield* withCompany(
      binding.companyId,
      CompanyDatabases.withFileObjectsLock(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`DELETE FROM patchy.file_uploads WHERE object_id = ${objectId} AND state = 'discarded'`
        )
      )
    );
  });
  const reclaimLateObject = Effect.fn("Files.reclaimLateObject")(function* (
    binding: StoreOwner,
    row: UploadRow
  ) {
    const discarded = yield* withCompany(
      binding.companyId,
      CompanyDatabases.withFileObjectsLock(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const referenced =
            yield* sql`SELECT 1 FROM patchy.files WHERE object_id = ${row.objectId}`;
          if (referenced.length !== 0) return false;
          const now = DateTime.formatIso(yield* DateTime.now);
          // Sweep may already have removed the writing row. Restore a tombstone so
          // a failed deletion remains eligible for the next sweep, regardless of age.
          const rows = yield* sql`INSERT INTO patchy.file_uploads
          (object_id, patch_id, size, content_type, sha256, expires_at, state)
          VALUES (${row.objectId}, ${binding.patchId}, ${row.size}, ${row.contentType}, ${row.sha256},
            ${now}::timestamptz, 'discarded')
          ON CONFLICT (object_id) DO UPDATE SET state = 'discarded'
            WHERE patchy.file_uploads.state IN ('writing', 'discarded')
          RETURNING object_id`;
          return rows.length !== 0;
        })
      )
    );
    if (discarded) yield* removeDiscardedObject(binding, row.objectId);
  });
  const stage = {
    kind: "read",
    transport: "bytes-put",
    run: (input: unknown, bytes?: Uint8Array) =>
      Effect.gen(function* () {
        const binding = yield* uploadBinding;
        const args = yield* decodeStage(input).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        if (bytes === undefined) return yield* new Runtime.InvalidRequest({});
        if (bytes.byteLength > stageLimits.bytes)
          return yield* new Runtime.TooLarge({
            maxBytes: stageLimits.bytes,
            limitId: "files.stage.bytes"
          });
        const row = yield* reserveUpload(binding, bytes, args.contentType);
        yield* withCompany(
          binding.companyId,
          CompanyDatabases.withFileObjectsLock(finishStage(row.objectId))
        ).pipe(
          Effect.catchTags({
            FileReservationExpired: () =>
              reclaimLateObject(binding, row).pipe(
                Effect.andThen(Effect.fail(new UploadNotFound()))
              )
          })
        );
        return { token: row.token, size: row.size, contentType: row.contentType };
      })
  } satisfies Runtime.BytesPutHandler;
  const inspectUpload = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["files.inspectUpload"].request.fields.args,
      output: runtimeOperations["files.inspectUpload"].response
    },
    (args) =>
      Effect.gen(function* () {
        const binding = yield* uploadBinding;
        const row = yield* withCompany(
          binding.companyId,
          CompanyDatabases.withFileObjectsLock(selectedUpload(binding, args.upload.token))
        );
        return { token: args.upload.token, size: row.size, contentType: row.contentType };
      })
  );
  const discard = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["files.discard"].request.fields.args,
      output: runtimeOperations["files.discard"].response
    },
    (args) =>
      Effect.gen(function* () {
        const binding = yield* uploadBinding;
        const row = yield* withCompany(
          binding.companyId,
          CompanyDatabases.withFileObjectsLock(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const row = yield* selectedUpload(binding, args.upload.token);
              yield* sql`UPDATE patchy.file_uploads SET state = 'discarded' WHERE object_id = ${row.objectId}`;
              return row;
            })
          )
        );
        // Once discarded, no adoption can win. Blob I/O needs no company lease.
        yield* removeDiscardedObject(binding, row.objectId);
        return null;
      })
  );
  const put = {
    kind: "mutation",
    transport: "bytes-put",
    resource,
    run: (input: unknown, bytes?: Uint8Array) =>
      Effect.gen(function* () {
        const args = yield* decodePut(input).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        if ("upload" in args) {
          if (bytes !== undefined) return yield* new Runtime.InvalidRequest({});
          const binding = yield* uploadBinding;
          return yield* withStore(args.store, () =>
            withWriteIndex(binding, args.store, args.name, () =>
              CompanyDatabases.withFileObjectsLock(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const row = yield* selectedUpload(binding, args.upload.token);
                  yield* sql`DELETE FROM patchy.file_uploads WHERE object_id = ${row.objectId}`;
                  return yield* indexObject(binding, args.store, args.name, row);
                })
              )
            )
          );
        }
        if (bytes === undefined) return yield* new Runtime.InvalidRequest({});
        if (bytes.byteLength > settings.fileBytes)
          return yield* new Runtime.TooLarge({
            maxBytes: settings.fileBytes,
            limitId: "runtime.file.bytes"
          });
        return yield* withStore(args.store, (binding) =>
          Effect.gen(function* () {
            const row = {
              objectId: newInternalId("obj"),
              size: bytes.byteLength,
              contentType: args.contentType,
              sha256: createHash("sha256").update(bytes).digest("hex")
            };
            yield* content
              .putBytes(objectKey(binding.patchId, row.objectId), bytes)
              .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
            return yield* withWriteIndex(binding, args.store, args.name, () =>
              indexObject(binding, args.store, args.name, row)
            );
          })
        );
      })
  } satisfies Runtime.BytesPutHandler;
  const getFile = Effect.fn("Files.getFile")(function* (
    binding: StoreOwner,
    args: { readonly store: string; readonly name: string }
  ) {
    const row = yield* withIndex(binding, args.store, args.name, () =>
      findFile({ patchId: binding.patchId, ...args }).pipe(
        Effect.catchTags({ SchemaError: Effect.die })
      )
    );
    if (Option.isNone(row)) return yield* new Runtime.InvalidRequest({});
    const bytes = yield* content
      .getBytes(objectKey(binding.patchId, row.value.objectId))
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    return { bytes, contentType: row.value.contentType };
  });
  const get = {
    kind: "read",
    transport: "bytes-get",
    run: (input: unknown) =>
      Effect.gen(function* () {
        const args = yield* decodeGet(input).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        return yield* withStore(args.store, (binding) => getFile(binding, args));
      })
  } satisfies Runtime.BytesGetHandler;
  const sharedGet = {
    kind: "read",
    transport: "bytes-get",
    run: (input: unknown) =>
      Effect.gen(function* () {
        const args = yield* decodeSharedGet(input).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        return yield* withSharedStore(args.alias, (owner, store) =>
          getFile(owner, { store, name: args.name })
        );
      })
  } satisfies Runtime.BytesGetHandler;
  const redeem = {
    kind: "read",
    transport: "bytes-get",
    run: (input: unknown) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        if (binding.manifest.tier !== 2 || binding.identity === null)
          return yield* new Runtime.AccessDenied({});
        const { handle } = yield* decodeRedeem(input).pipe(
          Effect.mapError((cause) => new Runtime.AccessDenied({ cause }))
        );
        const locator = handle.slice(0, 24);
        const pointer = yield* withCompany(
          binding.companyId,
          Effect.gen(function* () {
            const secret = yield* handleKey;
            if (
              !timingSafeEqual(
                Buffer.from(handle.slice(25)),
                Buffer.from(handleMac(secret, binding, locator))
              )
            )
              return yield* new Runtime.AccessDenied({});
            const pointer = yield* findObject(`obj_${locator}`);
            if (Option.isNone(pointer)) return yield* new NotFound();
            return pointer.value;
          }).pipe(Effect.catchTags({ SchemaError: Effect.die }))
        );
        if (
          pointer.patchId !== binding.patchId ||
          !Object.hasOwn(binding.manifest.files, pointer.store)
        ) {
          const declaration = Object.values(binding.manifest.uses).find(
            (use) =>
              use.kind === "sharedStore" &&
              use.patchId === pointer.patchId &&
              use.store === pointer.store
          );
          if (declaration?.kind !== "sharedStore") return yield* new Runtime.AccessDenied({});
          yield* sharedSourceAccess(binding, declaration);
        }
        const bytes = yield* content
          .getBytes(objectKey(pointer.patchId, pointer.objectId))
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
        return { bytes, contentType: pointer.contentType, name: pointer.name };
      })
  } satisfies Runtime.BytesGetHandler;
  const listFiles = Effect.fnUntraced(
    function* (
      binding: StoreOwner,
      args: typeof FileList.Type,
      consumer: Binding.Binding["Service"]
    ) {
      const sql = yield* CompanyDatabases.CompanyConnection;
      const key = consumer.manifest.tier === 2 ? yield* handleKey : undefined;
      const patchId = binding.patchId;
      const limit = args.limit ?? settings.defaultPage;
      if (limit > settings.maxPage) return yield* new PageLimit({ maxItems: settings.maxPage });
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
        `SELECT name, size, "contentType", "updatedAt"${key === undefined ? "" : ", handle"},
              row_number() OVER (ORDER BY name COLLATE "C") AS "__position"
            FROM (
              SELECT name, size, content_type AS "contentType",
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
                ${key === undefined ? "" : ", substring(object_id FROM 5) || '.' || repeat('0', 32) AS handle"}
              FROM patchy.files WHERE patch_id = $1 AND store = $2
                AND starts_with(name, $3) AND name COLLATE "C" > $4 COLLATE "C"
              ORDER BY name COLLATE "C" LIMIT $5
            ) AS selected`,
        [patchId, args.store, prefix, after, limit + 1],
        limit,
        settings.resultBytes
      );
      const metadata = decodeFiles(rows);
      const files =
        key === undefined
          ? metadata
          : metadata.map((file) => {
              const locator = file.handle!.slice(0, 24);
              return { ...file, handle: `${locator}.${handleMac(key, consumer, locator)}` };
            });
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
        return yield* new Runtime.TooLarge({
          maxBytes: settings.resultBytes,
          limitId: "runtime.result.bytes"
        });
      return result;
    },
    (effect, binding) => withCompany(binding.companyId, effect)
  );
  const list = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["files.list"].request.fields.args,
      output: runtimeOperations["files.list"].response
    },
    (args) => withStore(args.store, (binding) => listFiles(binding, args, binding))
  );
  const sharedList = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["shared.files.list"].request.fields.args,
      output: runtimeOperations["shared.files.list"].response
    },
    (args) =>
      withSharedStore(args.alias, (owner, store, consumer) =>
        listFiles(owner, { ...args, store }, consumer)
      )
  );
  const statFile = Effect.fnUntraced(
    function* (
      binding: StoreOwner,
      args: { readonly store: string; readonly name: string },
      consumer: Binding.Binding["Service"]
    ) {
      const sql = yield* CompanyDatabases.CompanyConnection;
      const rows = yield* sql`SELECT name, size::integer AS size, content_type AS "contentType",
              object_id AS "objectId",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
              FROM patchy.files
              WHERE patch_id = ${binding.patchId} AND store = ${args.store} AND name = ${args.name}`;
      const row = decodeFileRows(rows)[0];
      if (row === undefined) return null;
      const { objectId, ...file } = row;
      if (consumer.manifest.tier !== 2) return file;
      const secret = yield* handleKey;
      const locator = objectId.slice(4);
      return { ...file, handle: `${locator}.${handleMac(secret, consumer, locator)}` };
    },
    (effect, binding) => withCompany(binding.companyId, effect)
  );
  const stat = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["files.stat"].request.fields.args,
      output: runtimeOperations["files.stat"].response
    },
    (args) => withStore(args.store, (binding) => statFile(binding, args, binding))
  );
  const sharedStat = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["shared.files.stat"].request.fields.args,
      output: runtimeOperations["shared.files.stat"].response
    },
    (args) =>
      withSharedStore(args.alias, (owner, store, consumer) =>
        statFile(owner, { store, name: args.name }, consumer)
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
        withWriteIndex(binding, args.store, args.name, (sql) =>
          sql`DELETE FROM patchy.files WHERE patch_id = ${binding.patchId} AND store = ${args.store} AND name = ${args.name}`.pipe(
            Effect.as(null)
          )
        )
      )
  );
  return {
    "files.stage": stage,
    "files.discard": discard,
    "files.inspectUpload": inspectUpload,
    "files.put": put,
    "files.get": get,
    "files.redeem": redeem,
    "files.list": list,
    "files.stat": stat,
    "files.delete": remove,
    "shared.files.get": sharedGet,
    "shared.files.list": sharedList,
    "shared.files.stat": sharedStat
  } satisfies Readonly<Record<string, Runtime.Handler>>;
});

export const make = Effect.gen(function* () {
  const operating = yield* OperatingLimits.OperatingLimits;
  return yield* makeWithCompanyQuota((companyId) =>
    operating
      .get({ companyId, limitId: "files.stage.companyBytes" })
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
  );
});

/** Local dev has no platform database or company operating-limit overrides. */
export const makeLocal = makeWithCompanyQuota(() =>
  Effect.succeed({
    value: registry["files.stage.companyBytes"].default,
    configRevision: { deploymentRevision: "local", overrideRevision: "0" }
  })
);
