import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import { sharedTableId } from "@patchy/api";
import { ContentStore } from "@patchy/content-store";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as CompanyTesting from "@patchy/company-database/testing";
import { Tables } from "@patchy/primitives";
import * as Content from "./Content.js";
import * as ExpirySweep from "./ExpirySweep.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader } = Fixtures.identities;

/**
 * An in-memory store with a post-write hook for pausing publication or changing
 * its target between preflight and recording. Faults come from alternate layers.
 */
const memoryStore = (() => {
  const objects = Ref.makeUnsafe(new Map<string, { bytes: Uint8Array; lastModified: number }>());
  const control = { afterPut: Effect.void as Effect.Effect<void> };
  const service = ContentStore.ContentStore.of({
    list: (prefix) =>
      Stream.unwrap(
        Effect.map(Ref.get(objects), (map) =>
          Stream.fromIterable(
            [...map]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, object]) => ({ key, lastModified: object.lastModified }))
          )
        )
      ),
    put: Effect.fn(function* (key, html) {
      const lastModified = yield* Clock.currentTimeMillis;
      yield* Ref.update(objects, (map) =>
        new Map(map).set(key, { bytes: new TextEncoder().encode(html), lastModified })
      );
      yield* control.afterPut;
    }),
    get: (key) =>
      Effect.flatMap(Ref.get(objects), (map) => {
        const bytes = map.get(key)?.bytes;
        return bytes === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
      }),
    putBytes: Effect.fn(function* (key, bytes) {
      const lastModified = yield* Clock.currentTimeMillis;
      yield* Ref.update(objects, (map) =>
        new Map(map).set(key, { bytes: bytes.slice(), lastModified })
      );
    }),
    getBytes: (key) =>
      Effect.flatMap(Ref.get(objects), (map) => {
        const bytes = map.get(key)?.bytes;
        return bytes === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(bytes.slice());
      }),
    delete: (key) =>
      Ref.update(objects, (map) => {
        const next = new Map(map);
        next.delete(key);
        return next;
      })
  });
  return {
    control,
    service,
    layer: Layer.succeed(ContentStore.ContentStore, service),
    keys: Effect.map(Ref.get(objects), (map) => [...map.keys()].sort())
  };
})();

const store = memoryStore;
const unavailable = (operation: "put" | "delete", key: string) =>
  new ContentStore.StoreUnavailable({ operation, key, cause: new Error("down") });

/** The same store, refusing every put. */
const putFails = Layer.succeed(
  ContentStore.ContentStore,
  ContentStore.ContentStore.of({
    ...store.service,
    put: (key) => Effect.fail(unavailable("put", key))
  })
);

/** A write can succeed at the provider even when its reply reports failure. */
const putReplyLost = Layer.succeed(
  ContentStore.ContentStore,
  ContentStore.ContentStore.of({
    ...store.service,
    put: (key, html) =>
      store.service.put(key, html).pipe(Effect.andThen(Effect.fail(unavailable("put", key))))
  })
);

/** The same store, refusing every delete. */
const deleteFails = Layer.succeed(
  ContentStore.ContentStore,
  ContentStore.ContentStore.of({
    ...store.service,
    delete: (key) => Effect.fail(unavailable("delete", key))
  })
);

/** `Content` over a faulty store, sharing the block's `Patches`. */
const over = (faulty: Layer.Layer<ContentStore.ContentStore>) =>
  Effect.provide(Layer.effect(Content.Content, Content.make).pipe(Layer.provide(faulty)));

const content = Effect.flatMap(Content.Content, Effect.succeed);
const patches = Effect.flatMap(Patches.Patches, Effect.succeed);
const sweep = Effect.flatMap(ExpirySweep.ExpirySweep, (service) => service.sweep);

const publish = (
  html: string,
  patchId: string | null = null,
  extra: Partial<Content.PublishInput> = {}
) =>
  Effect.flatMap(content, (service) =>
    service.publish({
      ...Fixtures.publishRecord(),
      patchId,
      companyId: uploader.company.id,
      ownerUserId: uploader.user.id,
      machineTokenId: uploader.machine.id,
      title: "Page",
      html,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: "203.0.113.9",
      userAgent: "vitest",
      ...extra
    })
  );

it.layer(
  Layer.mergeAll(Content.layer, ExpirySweep.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Patches.layer, store.layer, Analytics.layerNoop)),
    Layer.provideMerge(Fixtures.database)
  )
)("Content", (it) => {
  it.effect("bootstraps a company database for a store-only publish", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT company_id FROM company_databases`, []);
      const created = yield* publish("<p>file store</p>", null, {
        manifest: { ...Fixtures.manifest, name: "first-store", files: { attachments: {} } }
      });
      assert.strictEqual(created.schemaRevision, 1);
      assert.deepStrictEqual(created.provisioned.stores, ["attachments"]);
      assert.deepStrictEqual(
        yield* sql`SELECT company_id AS "companyId", status FROM company_databases`,
        [{ companyId: uploader.company.id, status: "ready" }]
      );
      assert.deepStrictEqual(
        (yield* (yield* patches).inventory(created.patchId, uploader.user.id)).files,
        { attachments: {} }
      );
    })
  );

  it.effect("serializes competing store-only additions and provisions each store once", () =>
    Effect.gen(function* () {
      const manifest = {
        ...Fixtures.manifest,
        name: "serialized-stores",
        files: { attachments: {} }
      };
      const created = yield* publish("<p>initial</p>", null, { manifest });
      const ready = yield* Deferred.make<void>();
      let puts = 0;
      store.control.afterPut = Effect.gen(function* () {
        if (++puts === 2) yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(ready);
      });
      const results = yield* Effect.all(
        ["one", "two"].map((title) =>
          publish(`<p>${title}</p>`, created.patchId, {
            manifest: { ...manifest, files: { ...manifest.files, images: {} } }
          })
        ),
        { concurrency: "unbounded" }
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.deepStrictEqual(results.map((result) => result.versionNumber).sort(), [2, 3]);
      assert.deepStrictEqual(
        results.map((result) => result.schemaRevision),
        [2, 2]
      );
      assert.deepStrictEqual(
        results.flatMap((result) => result.provisioned.stores),
        ["images"]
      );
      const cumulative = yield* (yield* patches).inventory(created.patchId, uploader.user.id);
      assert.strictEqual(cumulative.schemaRevision, 2);
      assert.deepStrictEqual(cumulative.files, { attachments: {}, images: {} });
    })
  );

  it.effect(
    "keeps file objects through failed publish rollback, older manifests and version cleanup",
    () =>
      Effect.gen(function* () {
        const manifest = {
          ...Fixtures.manifest,
          name: "retained-files",
          files: { attachments: {} }
        };
        const created = yield* publish("<p>initial</p>", null, { manifest });
        const bytes = new Uint8Array([0, 255, 128, 1]);
        const key = `files/${created.patchId}/attachments/immutable-object`;
        yield* store.service.putBytes(key, bytes);
        const sql = yield* SqlClient.SqlClient;
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM patches WHERE id = ${created.patchId} FOR UPDATE`;
            yield* databases.withCompany(uploader.company.id)(
              databases.withPatchLock(created.patchId)(
                Effect.flatMap(
                  SqlClient.SqlClient,
                  (companySql) =>
                    companySql`INSERT INTO patchy.files
                    (patch_id, store, name, object_id, size, content_type, sha256)
                    VALUES (${created.patchId}, 'attachments', 'kept.bin', 'immutable-object',
                      ${bytes.byteLength}, 'application/octet-stream', ${createHash("sha256").update(bytes).digest("hex")})`
                )
              )
            );
          })
        );
        const failed = yield* publish("<p>not committed</p>", created.patchId, {
          manifest: { ...manifest, files: { ...manifest.files, images: {} } },
          machineTokenId: "missing-machine-token"
        }).pipe(Effect.flip);
        assert.strictEqual(failed._tag, "SqlError");
        const service = yield* patches;
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(created.patchId)).version.id,
          created.versionId
        );
        const cumulative = yield* service.inventory(created.patchId, uploader.user.id);
        assert.strictEqual(cumulative.schemaRevision, 2);
        assert.deepStrictEqual(cumulative.files, { attachments: {}, images: {} });
        yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
        yield* sweep;
        assert.deepStrictEqual(yield* store.service.getBytes(key), bytes);
        assert.deepStrictEqual(
          (yield* store.keys).filter((object) => object.startsWith(`patches/${created.patchId}/`)),
          [Content.objectKey(created.patchId, created.versionId)]
        );
        const omitted = yield* publish("<p>no stores</p>", created.patchId, {
          manifest: { ...Fixtures.manifest, name: manifest.name }
        });
        assert.strictEqual(omitted.schemaRevision, 2);
        assert.deepStrictEqual(omitted.unused.stores, ["attachments", "images"]);
        assert.deepStrictEqual(yield* store.service.getBytes(key), bytes);
        const older = yield* publish("<p>older manifest</p>", created.patchId, { manifest });
        assert.strictEqual(older.schemaRevision, 2);
        assert.deepStrictEqual(older.provisioned.stores, []);
        assert.deepStrictEqual(older.unused.stores, ["images"]);
        assert.deepStrictEqual(yield* store.service.getBytes(key), bytes);

        const expiredAt = (yield* Clock.currentTimeMillis) / 1_000 - 1;
        yield* sql`UPDATE patches SET expires_at = to_timestamp(${expiredAt}) WHERE id = ${created.patchId}`;
        yield* sweep;
        assert.isTrue(Option.isNone(yield* service.find(created.patchId)));
        assert.deepStrictEqual(
          (yield* store.keys).filter((object) => object.startsWith(`patches/${created.patchId}/`)),
          []
        );
        assert.deepStrictEqual(yield* store.service.getBytes(key), bytes);
        assert.deepStrictEqual(
          yield* databases.withCompany(uploader.company.id)(
            Effect.flatMap(
              SqlClient.SqlClient,
              (companySql) =>
                companySql`SELECT name, object_id AS "objectId" FROM patchy.files
                WHERE patch_id = ${created.patchId}`
            )
          ),
          [{ name: "kept.bin", objectId: "immutable-object" }]
        );
      })
  );

  it.effect("rechecks shared source revisions and access after the content write", () =>
    Effect.gen(function* () {
      const manifest = {
        ...Fixtures.manifest,
        name: "shared-racing-source",
        tables: {
          contacts: { columns: { name: { kind: "text" as const } }, indexes: {}, shared: true }
        }
      };
      const source = yield* publish("<p>source</p>", null, { manifest });
      const declaration = {
        kind: "sharedTable" as const,
        patchId: source.patchId,
        table: "contacts",
        id: sharedTableId(source.patchId, "contacts"),
        revision: source.schemaRevision
      };
      const consumerManifest = {
        ...Fixtures.manifest,
        name: "shared-racing-consumer",
        uses: { contacts: declaration }
      };
      const consumer = yield* publish("<p>consumer</p>", null, { manifest: consumerManifest });
      const evolvedManifest = {
        ...manifest,
        tables: {
          contacts: {
            ...manifest.tables.contacts,
            columns: {
              ...manifest.tables.contacts.columns,
              email: { kind: "text" as const, optional: true }
            }
          }
        }
      };
      store.control.afterPut = Effect.gen(function* () {
        store.control.afterPut = Effect.void;
        yield* publish("<p>new source revision</p>", source.patchId, { manifest: evolvedManifest });
      }).pipe(Effect.orDie);
      const updated = yield* publish(
        "<p>consumer records the new revision warning</p>",
        consumer.patchId,
        {
          manifest: consumerManifest
        }
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.isTrue(
        updated.warnings.some(
          (warning) => warning.includes(declaration.id) && warning.includes("revision 2")
        )
      );
      store.control.afterPut = Effect.gen(function* () {
        store.control.afterPut = Effect.void;
        yield* publish("<p>source unshares</p>", source.patchId, {
          manifest: {
            ...evolvedManifest,
            tables: { contacts: { ...evolvedManifest.tables.contacts, shared: false } }
          }
        });
      }).pipe(Effect.orDie);
      const failed = yield* publish(
        "<p>consumer loses access during storage</p>",
        consumer.patchId,
        {
          manifest: consumerManifest
        }
      ).pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.instanceOf(failed, Patches.PatchNotOpenable);
      const service = yield* patches;
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(consumer.patchId)).version.id,
        updated.versionId
      );
      assert.isFalse(
        (yield* service.inventory(source.patchId, uploader.user.id)).tables.contacts?.shared
      );
    })
  );

  it.effect(
    "keeps an unshare committed when platform recording fails or an older version is selected",
    () =>
      Effect.gen(function* () {
        const manifest = {
          ...Fixtures.manifest,
          name: "shared-rollback-source",
          tables: { contacts: { columns: {}, indexes: {}, shared: true } }
        };
        const source = yield* publish("<p>source</p>", null, { manifest });
        const unsharedManifest = {
          ...manifest,
          tables: { contacts: { ...manifest.tables.contacts, shared: false } }
        };
        const failed = yield* publish(
          "<p>unshare whose platform record fails</p>",
          source.patchId,
          {
            manifest: unsharedManifest,
            machineTokenId: "missing-machine-token"
          }
        ).pipe(Effect.flip);
        assert.strictEqual(failed._tag, "SqlError");
        const service = yield* patches;
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(source.patchId)).version.id,
          source.versionId
        );
        const inventory = yield* service.inventory(source.patchId, uploader.user.id);
        assert.strictEqual(inventory.schemaRevision, source.schemaRevision + 1);
        assert.isFalse(inventory.tables.contacts?.shared);
        assert.instanceOf(
          yield* service
            .sharedTable(source.patchId, "contacts", uploader.company.id)
            .pipe(Effect.flip),
          Patches.PatchNotOpenable
        );
        const retried = yield* publish("<p>retry records without resharing</p>", source.patchId, {
          manifest: unsharedManifest
        });
        assert.strictEqual(retried.schemaRevision, inventory.schemaRevision);
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM patches WHERE id = ${source.patchId} FOR UPDATE`;
            yield* sql`UPDATE patches SET current_version_id = ${source.versionId}
            WHERE id = ${source.patchId}`;
          })
        );
        assert.isTrue(
          Option.getOrThrow(yield* service.find(source.patchId)).version.manifest.tables.contacts
            ?.shared
        );
        assert.deepStrictEqual(
          yield* service.inventory(source.patchId, uploader.user.id),
          inventory
        );
        assert.instanceOf(
          yield* service
            .sharedTable(source.patchId, "contacts", uploader.company.id)
            .pipe(Effect.flip),
          Patches.PatchNotOpenable
        );
      })
  );

  it.effect("serializes competing table changes and re-diffs after the content write", () =>
    Effect.gen(function* () {
      const manifest = {
        ...Fixtures.manifest,
        name: "serialized-tables",
        tables: { notes: { columns: { title: { kind: "text" as const } }, indexes: {} } }
      };
      const created = yield* publish("<p>initial</p>", null, { manifest });
      const ready = yield* Deferred.make<void>();
      let puts = 0;
      store.control.afterPut = Effect.gen(function* () {
        if (++puts === 2) yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(ready);
      });
      const results = yield* Effect.all(
        (["text", "integer"] as const).map((kind) =>
          publish(`<p>${kind}</p>`, created.patchId, {
            manifest: {
              ...manifest,
              tables: {
                notes: {
                  ...manifest.tables.notes,
                  columns: { ...manifest.tables.notes.columns, label: { kind, optional: true } }
                }
              }
            }
          }).pipe(Effect.result)
        ),
        { concurrency: "unbounded" }
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");
      assert.strictEqual(successes.length, 1);
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]!.failure._tag, "NotAdditive");
      const winner = successes[0]!.success;
      assert.strictEqual(winner.versionNumber, 2);
      assert.strictEqual(winner.schemaRevision, 2);
      assert.deepStrictEqual(winner.provisioned.columns, ["notes.label"]);
      const service = yield* patches;
      const latest = Option.getOrThrow(yield* service.find(created.patchId));
      assert.strictEqual(latest.version.id, winner.versionId);
      const cumulative = yield* service.inventory(created.patchId, uploader.user.id);
      assert.strictEqual(cumulative.schemaRevision, 2);
      assert.strictEqual(
        cumulative.tables.notes?.columns.label?.kind,
        latest.version.manifest.tables.notes?.columns.label?.kind
      );
    })
  );

  it.effect("refuses oversized index keys and row expansion before writing content", () =>
    Effect.gen(function* () {
      const manifest = {
        ...Fixtures.manifest,
        name: "data-preflight",
        tables: { notes: { columns: { title: { kind: "text" as const } }, indexes: {} } }
      };
      const created = yield* publish("<p>initial</p>", null, { manifest });
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const qualified = `${Inventory.quoteIdentifier(Inventory.namespace(created.patchId))}."notes"`;
      yield* databases.withCompany(uploader.company.id)(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`INSERT INTO ${qualified} ("id", "title")
            SELECT 'existing', string_agg(md5(value::text), '')
            FROM generate_series(1, 160) AS value`)
        )
      );
      const before = yield* store.keys;
      for (const notes of [
        { ...manifest.tables.notes, indexes: { byTitle: { columns: ["title"] } } },
        {
          ...manifest.tables.notes,
          columns: {
            ...manifest.tables.notes.columns,
            expanded: { kind: "text" as const, default: "x".repeat(1024 * 1024) }
          }
        }
      ]) {
        const refused = yield* publish("<p>refused</p>", created.patchId, {
          manifest: { ...manifest, tables: { notes } }
        }).pipe(Effect.flip);
        assert.instanceOf(refused, Tables.NotAdditive);
        assert.deepStrictEqual(yield* store.keys, before);
      }
      const service = yield* patches;
      assert.strictEqual(
        (yield* service.inventory(created.patchId, uploader.user.id)).schemaRevision,
        1
      );
      yield* databases.withCompany(uploader.company.id)(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`UPDATE ${qualified} SET "title" = 'short'`)
        )
      );
      const indexed = yield* publish("<p>indexed</p>", created.patchId, {
        manifest: {
          ...manifest,
          tables: {
            notes: { ...manifest.tables.notes, indexes: { byTitle: { columns: ["title"] } } }
          }
        }
      });
      assert.strictEqual(indexed.versionNumber, 2);
      assert.deepStrictEqual(indexed.provisioned.indexes, ["notes.byTitle"]);
    })
  );

  it.effect("fails closed for claimed placements during inventory, preflight and recording", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>initial</p>");
      const databases = yield* CompanyDatabases.CompanyDatabases;
      yield* databases.ensureReady(uploader.company.id);
      const service = yield* patches;
      const sql = yield* SqlClient.SqlClient;
      const claim = sql`UPDATE company_databases SET status = 'claimed', ready_at = NULL
        WHERE company_id = ${uploader.company.id}`;
      const restore = sql`UPDATE company_databases SET status = 'ready', ready_at = now()
        WHERE company_id = ${uploader.company.id}`;
      yield* Effect.gen(function* () {
        yield* claim;
        const absent = yield* service
          .inventory(created.patchId, uploader.user.id)
          .pipe(Effect.flip);
        assert.instanceOf(absent, CompanyDatabases.CompanyDatabaseNotReady);
        assert.strictEqual(
          absent._tag === "CompanyDatabaseNotReady" ? absent.status : null,
          "claimed"
        );
        const before = yield* store.keys;
        const preflight = yield* publish("<p>refused before bytes</p>", created.patchId).pipe(
          Effect.flip
        );
        assert.instanceOf(preflight, CompanyDatabases.CompanyDatabaseNotReady);
        assert.deepStrictEqual(yield* store.keys, before);

        yield* restore;
        store.control.afterPut = claim.pipe(Effect.orDie, Effect.asVoid);
        const recorded = yield* publish("<p>refused after bytes</p>", created.patchId).pipe(
          Effect.flip
        );
        assert.instanceOf(recorded, CompanyDatabases.CompanyDatabaseNotReady);
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(created.patchId)).version.versionNumber,
          created.versionNumber
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          }).pipe(Effect.andThen(restore), Effect.orDie)
        )
      );
    })
  );

  it.effect(
    "recovers company-committed DDL after platform rollback even without version history",
    () =>
      Effect.gen(function* () {
        const created = yield* publish("<p>file born</p>");
        const manifest = {
          ...Fixtures.manifest,
          name: "adopted-table-repo",
          tables: { notes: { columns: { title: { kind: "text" as const } }, indexes: {} } }
        };
        const publishKey = crypto.randomUUID();
        const failed = yield* publish("<p>adopted</p>", created.patchId, {
          manifest,
          publishKey,
          machineTokenId: "missing-token"
        }).pipe(Effect.flip);
        assert.strictEqual(failed._tag, "SqlError");
        const service = yield* patches;
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(created.patchId)).version.schemaRevision,
          0
        );
        assert.isTrue(Option.isNone(yield* service.replay(uploader.user.id, publishKey)));
        const cumulative = yield* service.inventory(created.patchId, uploader.user.id);
        assert.strictEqual(cumulative.schemaRevision, 1);
        assert.strictEqual(cumulative.tables.notes?.columns.title?.kind, "text");
        const before = yield* store.keys;
        assert.strictEqual(
          (yield* publish("<p>file overwrite</p>", created.patchId).pipe(Effect.flip))._tag,
          "HasPrimitives"
        );
        assert.deepStrictEqual(yield* store.keys, before);
        const retried = yield* publish("<p>adopted</p>", created.patchId, { manifest, publishKey });
        assert.strictEqual(retried.versionNumber, 2);
        assert.strictEqual(retried.schemaRevision, 1);
        assert.deepStrictEqual(retried.provisioned, {
          tables: [],
          columns: [],
          indexes: [],
          stores: []
        });
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(created.patchId)).version.schemaRevision,
          1
        );
        assert.strictEqual(
          Option.getOrThrow(yield* service.replay(uploader.user.id, publishKey)).response
            .schemaRevision,
          1
        );
      })
  );

  it.effect("leaves failed creates as recoverable inventory without a platform patch", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      const manifest = {
        ...Fixtures.manifest,
        name: "orphan-table-repo",
        tables: { notes: { columns: {}, indexes: {} } }
      };
      const failed = yield* publish("<p>orphan</p>", null, {
        manifest,
        machineTokenId: "missing-token"
      }).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "SqlError");
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      const patchId = key.split("/")[1]!;
      assert.isTrue(Option.isNone(yield* (yield* patches).find(patchId)));
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const inventory = yield* Inventory.Inventory;
      const orphan = yield* databases.withCompany(uploader.company.id)(inventory.read(patchId));
      assert.isNotNull(orphan);
      assert.strictEqual(orphan!.schemaRevision, 1);
      assert.deepStrictEqual(
        orphan!.tables.map((table) => table.name),
        ["notes"]
      );
    })
  );

  it.effect("stores the bytes, records the version, and reads both back", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>one</p>");
      assert.strictEqual(created.versionNumber, 1);
      const updated = yield* publish("<p>two</p>", created.patchId);
      assert.strictEqual(updated.versionNumber, 2);

      const service = yield* content;
      const found = yield* patches;
      const latest = Option.getOrThrow(yield* found.find(created.patchId));
      assert.strictEqual(yield* service.read(latest.version), "<p>two</p>");
      assert.strictEqual(latest.version.sourceIp, "203.0.113.9");
      const first = Option.getOrThrow(yield* found.find(created.patchId, 1));
      assert.strictEqual(yield* service.read(first.version), "<p>one</p>");
      assert.deepStrictEqual(
        (yield* store.keys).filter((key) => key.startsWith(`patches/${created.patchId}/`)),
        [
          Content.objectKey(created.patchId, created.versionId),
          Content.objectKey(updated.patchId, updated.versionId)
        ].sort()
      );
    })
  );

  it.effect("refuses a taken publish key with bounded diagnostics and preserves its version", () =>
    Effect.gen(function* () {
      const publishKey = `${crypto.randomUUID()}\n${"unsafe-key".repeat(128)}`;
      const created = yield* publish("<p>original</p>", null, { publishKey });
      const error = yield* publish("<p>conflicting</p>", created.patchId, { publishKey }).pipe(
        Effect.flip
      );
      assert.strictEqual(error._tag, "PublishKeyTaken");
      if (error._tag !== "PublishKeyTaken") return;
      assert.include(error.message, uploader.user.id);
      assert.include(error.message, String(publishKey.length));
      assert.isBelow(error.message.length, 200);
      assert.notInclude(error.message, "unsafe-key");
      assert.notInclude(JSON.stringify(error), "unsafe-key");
      const service = yield* patches;
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(created.patchId)).version.versionNumber,
        1
      );
      assert.strictEqual(
        Option.getOrThrow(yield* service.replay(uploader.user.id, publishKey)).response.versionId,
        created.versionId
      );
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
    })
  );

  it.effect("writes nothing when the store refuses the object", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>original</p>");
      const failed = yield* publish("<p>lost</p>", created.patchId).pipe(
        over(putFails),
        Effect.flip
      );
      assert.strictEqual(failed._tag, "StoreUnavailable");
      const current = Option.getOrThrow(yield* (yield* patches).find(created.patchId));
      assert.strictEqual(yield* (yield* content).read(current.version), "<p>original</p>");
    })
  );

  it.effect("reclaims bytes after a target refusal without removing its older version", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>original</p>");
      const before = yield* store.keys;
      // The patch is taken down between the preflight and the row insert.
      store.control.afterPut = Effect.flatMap(patches, (service) =>
        service.delete(created.patchId, uploader.user.id).pipe(Effect.orDie, Effect.asVoid)
      );
      const refused = yield* publish("<p>rejected</p>", created.patchId).pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.strictEqual(refused._tag, "PatchUnavailable");
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
      assert.strictEqual(
        yield* store.service.get(Content.objectKey(created.patchId, created.versionId)),
        "<p>original</p>"
      );
    })
  );

  it.effect("reclaims an object whose write succeeded but whose reply failed", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      const publishKey = crypto.randomUUID();
      const error = yield* publish("<p>unacknowledged</p>", null, { publishKey }).pipe(
        over(putReplyLost),
        Effect.flip
      );
      assert.strictEqual(error._tag, "StoreUnavailable");
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      assert.strictEqual(yield* store.service.get(key), "<p>unacknowledged</p>");
      assert.isTrue(Option.isNone(yield* (yield* patches).replay(uploader.user.id, publishKey)));

      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
    })
  );

  it.effect("reclaims an object when the version transaction rolls back", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>original</p>");
      const before = yield* store.keys;
      const publishKey = crypto.randomUUID();
      const error = yield* publish("<p>rolled back</p>", created.patchId, {
        publishKey,
        machineTokenId: "missing-machine-token"
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SqlError");
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      assert.strictEqual(yield* store.service.get(key), "<p>rolled back</p>");
      const service = yield* patches;
      assert.isTrue(Option.isNone(yield* service.replay(uploader.user.id, publishKey)));
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(created.patchId)).version.versionNumber,
        1
      );

      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
      assert.strictEqual(
        yield* (yield* content).read(
          Option.getOrThrow(yield* service.find(created.patchId)).version
        ),
        "<p>original</p>"
      );
    })
  );

  it.effect("retains live bytes and replay when commit succeeded but its reply failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        sql.withTransaction(effect).pipe(
          Effect.andThen(
            Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.ConnectionError({ cause: new Error("commit reply lost") })
              })
            )
          )
        );
      const uncertainSql = new Proxy(sql, {
        get: (target, property, receiver) =>
          property === "withTransaction" ? withTransaction : Reflect.get(target, property, receiver)
      });
      const uncertain = Layer.effect(Content.Content, Content.make).pipe(
        Layer.provide(
          Layer.effect(Patches.Patches, Patches.make).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, uncertainSql))
          )
        )
      );
      const publishKey = crypto.randomUUID();
      const error = yield* publish("<p>committed</p>", null, { publishKey }).pipe(
        Effect.provide(uncertain),
        Effect.flip
      );
      assert.strictEqual(error._tag, "SqlError");
      const service = yield* patches;
      const replay = Option.getOrThrow(yield* service.replay(uploader.user.id, publishKey));
      assert.strictEqual(replay.status, 201);
      const patchId = replay.response.patchId as string;
      const version = Option.getOrThrow(yield* service.find(patchId)).version;

      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.strictEqual(yield* (yield* content).read(version), "<p>committed</p>");
      assert.deepStrictEqual(
        yield* service.replay(uploader.user.id, publishKey),
        Option.some(replay)
      );
    })
  );

  it.effect("retries reclamation after the store refuses deletion", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      yield* publish("<p>retry deletion</p>").pipe(over(putReplyLost), Effect.flip);
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      const failed = yield* sweep.pipe(
        Effect.provide(
          Layer.effect(ExpirySweep.ExpirySweep, ExpirySweep.make).pipe(Layer.provide(deleteFails))
        )
      );
      assert.strictEqual(failed.orphanedObjects, 1);
      assert.strictEqual(yield* store.service.get(key), "<p>retry deletion</p>");

      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
      assert.deepStrictEqual(yield* (yield* patches).claimObjects(100), []);
    })
  );

  it.effect("does not reclaim bytes while their publication is active", () =>
    Effect.gen(function* () {
      const stored = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const before = yield* store.keys;
      store.control.afterPut = Deferred.succeed(stored, undefined).pipe(
        Effect.andThen(Deferred.await(resume))
      );
      const publication = yield* publish("<p>in flight</p>").pipe(
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        ),
        Effect.forkScoped
      );
      yield* Deferred.await(stored);
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      yield* TestClock.adjust("30 seconds");
      yield* sweep;
      assert.strictEqual(yield* store.service.get(key), "<p>in flight</p>");
      yield* Deferred.succeed(resume, undefined);
      const published = yield* Fiber.join(publication);
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      const version = Option.getOrThrow(yield* (yield* patches).find(published.patchId)).version;
      assert.strictEqual(yield* (yield* content).read(version), "<p>in flight</p>");
    })
  );

  it.effect("skips a record transaction's locked intent when its lease expires", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ready = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const before = yield* store.keys;
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        sql.withTransaction(
          effect.pipe(
            Effect.tap(() =>
              Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            )
          )
        );
      const heldSql = new Proxy(sql, {
        get: (target, property, receiver) =>
          property === "withTransaction" ? withTransaction : Reflect.get(target, property, receiver)
      });
      const held = Layer.effect(Content.Content, Content.make).pipe(
        Layer.provide(
          Layer.effect(Patches.Patches, Patches.make).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, heldSql))
          )
        )
      );
      store.control.afterPut = Effect.gen(function* () {
        const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
        // Shorten only this test's lease so the transaction's own deadline stays live.
        yield* sql`
          UPDATE pending_patch_objects SET expires_at = expires_at - interval '4 minutes 59 seconds'
          WHERE object_key = ${key}`;
      }).pipe(Effect.orDie);
      const publication = yield* publish("<p>committing</p>").pipe(
        Effect.provide(held),
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        ),
        Effect.forkScoped
      );
      yield* Deferred.await(ready);
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      yield* TestClock.adjust("2 seconds");
      yield* sweep;
      assert.strictEqual(yield* store.service.get(key), "<p>committing</p>");
      yield* Deferred.succeed(resume, undefined);
      const published = yield* Fiber.join(publication);
      yield* sweep;
      const version = Option.getOrThrow(yield* (yield* patches).find(published.patchId)).version;
      assert.strictEqual(yield* (yield* content).read(version), "<p>committing</p>");
    })
  );

  it.effect("refuses a late version after the sweep claims its pending object", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      const service = yield* patches;
      const sql = yield* SqlClient.SqlClient;
      const publishKey = crypto.randomUUID();
      store.control.afterPut = Effect.gen(function* () {
        const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
        // Force the lease boundary without timing out the paused uploader.
        yield* sql`UPDATE pending_patch_objects SET expires_at = to_timestamp(0) WHERE object_key = ${key}`;
        yield* service.claimObjects(100);
      }).pipe(Effect.orDie);
      const error = yield* publish("<p>too late</p>", null, { publishKey }).pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.strictEqual(error._tag, "PendingObjectExpired");
      assert.isTrue(Option.isNone(yield* service.replay(uploader.user.id, publishKey)));
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
    })
  );
});

it.layer(
  Content.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Patches.layer, store.layer)),
    Layer.provideMerge(Fixtures.integrations),
    Layer.provideMerge(
      Tables.layer.pipe(Layer.provideMerge(CompanyTesting.layer({ maxBackends: 0 })))
    )
  )
)("primitive-free publish", (it) => {
  it.effect("needs neither a placement nor an available company lease", () =>
    Effect.gen(function* () {
      const identity = Fixtures.identities.admin;
      const owner = {
        ownerUserId: identity.user.id,
        machineTokenId: identity.machine.id,
        companyId: identity.company.id
      };
      const first = yield* publish("<p>no database</p>", null, owner);
      assert.strictEqual(first.schemaRevision, 0);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT company_id FROM company_databases`, []);
      const databases = yield* CompanyDatabases.CompanyDatabases;
      yield* databases.ensureReady(identity.company.id);
      assert.strictEqual(
        (yield* databases.withCompany(identity.company.id)(Effect.void).pipe(Effect.flip))._tag,
        "Busy"
      );
      const second = yield* publish("<p>company pool unavailable</p>", null, owner);
      assert.strictEqual(second.schemaRevision, 0);
      const latest = Option.getOrThrow(yield* (yield* patches).find(second.patchId));
      assert.strictEqual(
        yield* (yield* content).read(latest.version),
        "<p>company pool unavailable</p>"
      );
    })
  );
});
