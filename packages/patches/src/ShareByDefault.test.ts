import { assert, it } from "@effect/vitest";
import { Analytics } from "@patchy/analytics";
import type { Manifest } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { Tables } from "@patchy/primitives";
import { Wakes } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { newPatchId } from "../../../test/crypto.js";
import * as Patches from "./Patches.js";
import * as ShareByDefault from "./ShareByDefault.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader } = Fixtures.identities;
const companyId = uploader.company.id;
const columns = { body: { kind: "text" as const } };

const manifest = (
  name: string,
  tables: (typeof Manifest.Type)["tables"],
  files: (typeof Manifest.Type)["files"] = {}
): typeof Manifest.Type => ({ ...Fixtures.manifest, name, tables, files });

/** Publishes a patch, then sets flags the way an earlier release or a failed publish left them. */
const publish = Effect.fn("ShareByDefaultTest.publish")(function* (
  definition: typeof Manifest.Type,
  flags: Readonly<Record<string, boolean>>
) {
  const request = Fixtures.recordInput(uploader, { manifest: definition });
  yield* (yield* Patches.Patches).preflight(request);
  yield* Fixtures.record(request);
  yield* setFlags(request.patchId, flags);
  return request.patchId;
});

const setFlags = Effect.fn("ShareByDefaultTest.setFlags")(function* (
  patchId: string,
  flags: Readonly<Record<string, boolean>>
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(patchId)(
      Effect.gen(function* () {
        const snapshot = (yield* inventory.read(patchId))!;
        for (const table of snapshot.tables)
          if (Object.hasOwn(flags, table.name))
            yield* inventory.putTable({ ...table, shared: flags[table.name]! });
        for (const store of snapshot.stores)
          if (Object.hasOwn(flags, store.name))
            yield* inventory.putStore({ ...store, shared: flags[store.name]! });
      })
    )
  );
});

const snapshot = (patchId: string) =>
  Effect.flatMap(CompanyDatabases.CompanyDatabases, (databases) =>
    databases.withCompany(companyId)(
      Effect.flatMap(Inventory.Inventory, (inventory) => inventory.read(patchId))
    )
  );
const flags = (patchId: string) =>
  Effect.map(snapshot(patchId), (inventory) =>
    Object.fromEntries(
      [...inventory!.tables, ...inventory!.stores].map((resource) => [
        resource.name,
        resource.shared
      ])
    )
  );

it.layer(
  Patches.layer.pipe(Layer.provideMerge(Analytics.layerNoop), Layer.provideMerge(Fixtures.database))
)("ShareByDefault", (it) => {
  it.effect("shares only what config never opted out, never unshares, and reruns as a no-op", () =>
    Effect.gen(function* () {
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const tables = yield* Tables.Tables;
      const wakes = yield* Wakes.Wakes;
      yield* databases.ensureReady(companyId);

      // Never mentions `shared`, as every config did; the earlier release stored false.
      const legacy = yield* publish(
        manifest(
          "flip-legacy",
          {
            notes: { description: "Notes keyed by id.", columns, indexes: {} },
            secrets: { description: "Per-person notes.", columns, indexes: {}, shared: false }
          },
          {
            photos: { description: "Photos keyed by filename." },
            contracts: { description: "Contracts keyed by filename.", shared: false }
          }
        ),
        { notes: false, photos: false }
      );
      // A table a failed publish left behind: inventory the newest version never defined.
      yield* databases.withCompany(companyId)(
        databases.withPatchLock(legacy)(
          tables.provision(legacy, {
            ...manifest("flip-legacy", {
              drafts: { description: "Drafts keyed by id.", columns, indexes: {}, shared: false }
            })
          })
        )
      );
      // Company provisioning shared it, then the platform publish saying `shared: false` failed.
      const opted = yield* publish(
        manifest("flip-opted", {
          notes: { description: "Notes keyed by id.", columns, indexes: {}, shared: false }
        }),
        { notes: true }
      );
      // Inventory whose platform row is gone belongs to the reclamation sweep.
      const orphan = newPatchId();
      yield* databases.withCompany(companyId)(
        databases.withPatchLock(orphan)(
          tables.provision(
            orphan,
            manifest("flip-orphan", {
              notes: { description: "Notes keyed by id.", columns, indexes: {}, shared: false }
            })
          )
        )
      );

      const before = yield* snapshot(legacy);
      const woken: string[] = [];
      yield* wakes.subscribe((keys) => Effect.sync(() => void woken.push(...keys)));

      const first = yield* ShareByDefault.company(companyId);
      assert.strictEqual(first.skipped, 1);
      assert.isAtLeast(first.patches, 2);
      assert.sameDeepMembers(
        first.shared.filter((resource) => resource.patchId === legacy),
        [
          { patchId: legacy, kind: "table", name: "drafts" },
          { patchId: legacy, kind: "table", name: "notes" },
          { patchId: legacy, kind: "store", name: "photos" }
        ]
      );
      assert.deepStrictEqual(
        first.leftShared.filter((resource) => resource.patchId === opted),
        [{ patchId: opted, kind: "table", name: "notes" }]
      );
      assert.deepStrictEqual(yield* flags(legacy), {
        drafts: true,
        notes: true,
        secrets: false,
        photos: true,
        contracts: false
      });
      assert.deepStrictEqual(yield* flags(opted), { notes: true });
      assert.deepStrictEqual(yield* flags(orphan), { notes: false });
      const after = (yield* snapshot(legacy))!;
      assert.strictEqual(after.schemaRevision, before!.schemaRevision + 1);
      assert.sameMembers(
        woken.filter((key) => key.includes(legacy)),
        [`table:${legacy}:drafts`, `table:${legacy}:notes`, `store:${legacy}:photos`]
      );

      woken.length = 0;
      const second = yield* ShareByDefault.company(companyId);
      assert.deepStrictEqual(second.shared, []);
      assert.deepStrictEqual(second.leftShared, first.leftShared);
      assert.deepStrictEqual(yield* snapshot(legacy), after);
      assert.deepStrictEqual(woken, []);
    }).pipe(Effect.scoped)
  );
});
