import { assert } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as CompanyDatabases from "../CompanyDatabases.js";
import * as Inventory from "../Inventory.js";

const readCodecs = SqlSchema.findOne({
  Request: Schema.Void,
  Result: Schema.Struct({ small: Schema.String, large: Schema.String, day: Schema.String }),
  execute: Effect.fn("Contract.readCodecs")(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT 42::bigint AS "small", 9223372036854775807::bigint AS "large",
      '2024-02-29'::date AS "day"`;
  })
});

const readFile = SqlSchema.findOne({
  Request: Schema.String,
  Result: Schema.Struct({
    patchId: Schema.String,
    store: Schema.String,
    name: Schema.String,
    objectId: Schema.String,
    size: Schema.String,
    contentType: Schema.String,
    sha256: Schema.String,
    updatedAt: Schema.Date
  }),
  execute: Effect.fn("Contract.readFile")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT "patch_id" AS "patchId", "store", "name", "object_id" AS "objectId",
      "size", "content_type" AS "contentType", "sha256", "updated_at" AS "updatedAt"
      FROM "patchy"."files" WHERE "patch_id" = ${patchId}`;
  })
});

/** Run identically against the real PostgreSQL and directory-backed PGlite services. */
export const inventoryContract = Effect.fn("Contract.inventory")(function* (companyId: string) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;
  const claimed = yield* databases.claim(companyId);
  const ready = yield* databases.ensureReady(companyId);
  assert.strictEqual(ready.companyId, companyId);
  assert.strictEqual(ready.status, "ready");
  assert.strictEqual(ready.databaseName, claimed.databaseName);
  assert.strictEqual(
    (yield* databases.ensureReady(companyId)).placementVersion,
    ready.placementVersion
  );

  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const patchId = 'contract"Case';
      const table = 'notes"Case';
      const qualified = `${Inventory.quoteIdentifier(Inventory.namespace(patchId))}.${Inventory.quoteIdentifier(table)}`;
      assert.strictEqual(yield* inventory.read(patchId), null);

      yield* databases.withPatchLock(patchId)(
        Effect.gen(function* () {
          assert.strictEqual(yield* inventory.ensurePatch(patchId), 0);
          yield* sql.unsafe(`CREATE TABLE ${qualified} ("body" text NOT NULL)`);
          yield* sql.unsafe(`INSERT INTO ${qualified} ("body") VALUES ('kept')`);
          yield* inventory.putTable({ patchId, name: table, shared: true });
          yield* inventory.putColumn({
            patchId,
            table,
            name: "body",
            kind: "text",
            refTable: null,
            optional: false,
            defaultKind: "constant",
            defaultValue: "first"
          });
          yield* inventory.putIndex({
            patchId,
            table,
            name: "byBody",
            columns: ["body"],
            unique: false
          });
          yield* inventory.putStore({ patchId, name: "documents" });
          assert.strictEqual(yield* inventory.bumpRevision(patchId), 1);
        })
      );

      const initial = yield* inventory.read(patchId);
      assert.isNotNull(initial);
      if (initial === null) return;
      assert.strictEqual(initial.tables[0]?.name, table);
      assert.strictEqual(initial.columns[0]?.defaultValue, "first");
      assert.deepStrictEqual(initial.indexes[0]?.columns, ["body"]);
      assert.isTrue(initial.createdAt instanceof Date);

      // A later manifest can add rows and change sharing without erasing omissions.
      yield* databases.withPatchLock(patchId)(
        Effect.gen(function* () {
          assert.strictEqual(yield* inventory.ensurePatch(patchId), 1);
          yield* sql.unsafe(`ALTER TABLE ${qualified} ADD COLUMN "metadata" jsonb`);
          yield* inventory.putTable({ patchId, name: table, shared: false });
          yield* inventory.putColumn({
            patchId,
            table,
            name: "metadata",
            kind: "json",
            refTable: null,
            optional: true,
            defaultKind: "constant",
            defaultValue: { nested: [true, null, "value"] }
          });
          yield* inventory.putStore({ patchId, name: "pictures" });
          assert.strictEqual(yield* inventory.bumpRevision(patchId), 2);
        })
      );
      const cumulative = yield* inventory.read(patchId);
      assert.isNotNull(cumulative);
      if (cumulative === null) return;
      assert.deepStrictEqual(
        cumulative.columns.map((column) => column.name),
        ["body", "metadata"]
      );
      assert.deepStrictEqual(cumulative.columns[1]?.defaultValue, {
        nested: [true, null, "value"]
      });
      assert.deepStrictEqual(
        cumulative.stores.map((store) => store.name),
        ["documents", "pictures"]
      );
      assert.strictEqual(cumulative.tables[0]?.shared, false);
      assert.deepStrictEqual(cumulative.indexes, initial.indexes);
      assert.deepStrictEqual(cumulative.createdAt, initial.createdAt);
      assert.deepStrictEqual(cumulative.tables[0]?.createdAt, initial.tables[0]?.createdAt);

      const unlockedPatchId = "unlocked-new-patch";
      const writes: ReadonlyArray<Effect.Effect<unknown, SqlError, CompanyDatabases.PatchLock>> = [
        inventory.ensurePatch(unlockedPatchId),
        inventory.putTable({ patchId, name: table, shared: true }),
        inventory.putColumn({
          patchId,
          table,
          name: "forbidden",
          kind: "text",
          refTable: null,
          optional: true,
          defaultKind: null,
          defaultValue: null
        }),
        inventory.putIndex({
          patchId,
          table,
          name: "forbidden",
          columns: ["body"],
          unique: true
        }),
        inventory.putStore({ patchId, name: "forbidden" }),
        inventory.bumpRevision(patchId)
      ];
      for (const write of writes) {
        // Deliberately bypass the type boundary to cover callers without a lock.
        // @ts-expect-error The company lease alone cannot authorize an inventory write.
        const unlocked: Effect.Effect<unknown, SqlError> = write;
        const missing = yield* unlocked.pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(missing) && Cause.hasDies(missing.cause));
        const mismatched = yield* databases.withPatchLock("wrong-patch")(write).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(mismatched) && Cause.hasDies(mismatched.cause));
      }
      assert.deepStrictEqual(yield* inventory.read(patchId), cumulative);
      assert.strictEqual(yield* inventory.read(unlockedPatchId), null);
      assert.deepStrictEqual(
        yield* sql`SELECT nspname FROM pg_namespace
      WHERE nspname = ${Inventory.namespace(unlockedPatchId)}`,
        []
      );

      const aborted = yield* databases
        .withPatchLock(patchId)(
          Effect.gen(function* () {
            yield* sql.unsafe(`ALTER TABLE ${qualified} ADD COLUMN "rolledBack" integer`);
            yield* inventory.putColumn({
              patchId,
              table,
              name: "rolledBack",
              kind: "integer",
              refTable: null,
              optional: true,
              defaultKind: null,
              defaultValue: null
            });
            yield* inventory.putTable({ patchId, name: table, shared: true });
            yield* inventory.bumpRevision(patchId);
            return yield* Effect.fail("abort-provisioning");
          })
        )
        .pipe(Effect.flip);
      assert.strictEqual(aborted, "abort-provisioning");
      assert.deepStrictEqual(yield* inventory.read(patchId), cumulative);
      const physical = yield* sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${Inventory.namespace(patchId)} AND table_name = ${table}
      ORDER BY ordinal_position`;
      assert.deepStrictEqual(physical, [{ column_name: "body" }, { column_name: "metadata" }]);
      assert.deepStrictEqual(yield* sql.unsafe(`SELECT "body", "metadata" FROM ${qualified}`), [
        { body: "kept", metadata: null }
      ]);

      // First-time failure must roll back both the namespace and its age/authority row.
      yield* databases
        .withPatchLock("aborted-new-patch")(
          inventory.ensurePatch("aborted-new-patch").pipe(Effect.andThen(Effect.fail("abort-new")))
        )
        .pipe(Effect.flip);
      assert.strictEqual(yield* inventory.read("aborted-new-patch"), null);
      assert.deepStrictEqual(
        yield* sql`SELECT nspname FROM pg_namespace
      WHERE nspname = ${Inventory.namespace("aborted-new-patch")}`,
        []
      );

      assert.deepStrictEqual(yield* readCodecs(undefined), {
        small: "42",
        large: "9223372036854775807",
        day: "2024-02-29"
      });
      yield* databases.withPatchLock(patchId)(
        sql`INSERT INTO "patchy"."files"
      ("patch_id", "store", "name", "object_id", "size", "content_type", "sha256")
      VALUES (${patchId}, 'documents', 'folder/report.txt', 'object-one', 42, 'text/plain', 'digest')`
      );
      const file = yield* readFile(patchId);
      assert.strictEqual(file.name, "folder/report.txt");
      assert.strictEqual(file.size, "42");
      assert.strictEqual(file.objectId, "object-one");
      assert.strictEqual(file.contentType, "text/plain");
      assert.strictEqual(file.sha256, "digest");
      assert.isTrue(file.updatedAt instanceof Date);
    })
  );
});
