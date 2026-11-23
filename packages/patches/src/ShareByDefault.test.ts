import { assert, it } from "@effect/vitest";
import { Analytics } from "@patchy/analytics";
import type { Manifest } from "@patchy/api";
import {
  CompanyDatabases,
  Inventory,
  PgCompanyDatabases,
  ResourceChanges
} from "@patchy/company-database";
import { Tables } from "@patchy/primitives";
import { Wakes, WakesPostgres } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { inject } from "vitest";
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

const publishUpdate = Effect.fn("ShareByDefaultTest.publishUpdate")(function* (
  patchId: string,
  definition: typeof Manifest.Type
) {
  const request = Fixtures.recordInput(uploader, {
    intent: "update",
    patchId,
    manifest: definition
  });
  yield* (yield* Patches.Patches).preflight(request);
  yield* Fixtures.record(request);
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
      // A table a failed publish left behind: inventory no retained version ever defined.
      yield* databases.withCompany(companyId)(
        databases.withPatchLock(legacy)(
          tables.provision(legacy, {
            ...manifest("flip-legacy", {
              drafts: { description: "Drafts keyed by id.", columns, indexes: {}, shared: false }
            })
          })
        )
      );
      // Opted out in v1, then omitted in v2: omission keeps the opt-out, so the flip must keep it unshared.
      const omittedOptOut = yield* publish(
        manifest(
          "flip-omitted-optout",
          {
            secrets: { description: "Per-person notes.", columns, indexes: {}, shared: false }
          },
          {
            contracts: { description: "Contracts keyed by filename.", shared: false }
          }
        ),
        {}
      );
      yield* publishUpdate(omittedOptOut, manifest("flip-omitted-optout", {}, {}));
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
      assert.isAtLeast(first.patches, 3);
      assert.sameDeepMembers(
        first.shared.filter((resource) => resource.patchId === legacy),
        [
          { patchId: legacy, kind: "table", name: "drafts" },
          { patchId: legacy, kind: "table", name: "notes" },
          { patchId: legacy, kind: "store", name: "photos" }
        ]
      );
      assert.deepStrictEqual(
        first.shared.filter((resource) => resource.patchId === omittedOptOut),
        []
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
      assert.deepStrictEqual(yield* flags(omittedOptOut), {
        secrets: false,
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

  it.effect(
    "fails with a bounded UnsharedRemain error when closing verification still sees unshared resources",
    () =>
      Effect.gen(function* () {
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const realInventory = yield* Inventory.Inventory;
        yield* databases.ensureReady(companyId);

        const names = ["t1", "t2", "t3", "t4", "t5", "t6"] as const;
        const patchId = yield* publish(
          manifest(
            "flip-unverified",
            Object.fromEntries(
              names.map((name) => [name, { description: `Table ${name}.`, columns, indexes: {} }])
            )
          ),
          Object.fromEntries(names.map((name) => [name, false]))
        );

        // Drop writes to prove the closing re-check fails with a bounded summary message.
        const stuckInventory = Inventory.Inventory.of({
          ...realInventory,
          putTable: () => Effect.void
        });
        const failure = yield* ShareByDefault.company(companyId).pipe(
          Effect.provideService(Inventory.Inventory, stuckInventory),
          Effect.flip
        );
        assert.instanceOf(failure, ShareByDefault.UnsharedRemain);
        assert.strictEqual(failure.companyId, companyId);
        assert.sameDeepMembers(
          failure.resources.filter((resource) => resource.patchId === patchId),
          names.map((name) => ({ patchId, kind: "table" as const, name }))
        );
        assert.include(
          failure.message,
          `${failure.resources.length} resources in company ${companyId}`
        );
        assert.include(failure.message, `, and ${failure.resources.length - 5} more.`);
        // Leave the shared test database clean for subsequent cases.
        yield* ShareByDefault.company(companyId);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "delivers Postgres NOTIFY wakes to a separate listener through the fleet wiring and none on rerun",
    () =>
      Effect.gen(function* () {
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* databases.ensureReady(companyId);

        const patchId = yield* publish(
          manifest(
            "flip-pg-wakes",
            { notes: { description: "Notes keyed by id.", columns, indexes: {} } },
            { photos: { description: "Photos keyed by filename." } }
          ),
          { notes: false, photos: false }
        );

        // Wire PgCompanyDatabases + Inventory over WakesPostgres as apps/server/src/fleet.ts does,
        // and listen on a separate WakesPostgres instance modeling another live host.
        const url = Redacted.make(inject("postgres").adminUrl);
        const fleetWakes = yield* WakesPostgres.make;
        const fleetChanges = Layer.succeed(
          ResourceChanges.ResourceChanges,
          ResourceChanges.ResourceChanges.of({ publish: fleetWakes.publish })
        );
        const fleetDatabases = Layer.mergeAll(
          Layer.effect(CompanyDatabases.CompanyDatabases, PgCompanyDatabases.make).pipe(
            Layer.provide(PgCompanyDatabases.placementLayer),
            Layer.provide(PgCompanyDatabases.adminLayer),
            Layer.provide(Reactivity.layer),
            Layer.provide(
              Layer.succeed(PgCompanyDatabases.CompanyDatabaseConfig, {
                adminUrl: url,
                dataUrl: url,
                maxBackends: 8,
                capacity: 10
              })
            )
          ),
          Inventory.layer
        ).pipe(Layer.provide(fleetChanges));

        const remote = yield* WakesPostgres.make;
        const received = yield* Queue.unbounded<readonly string[]>();
        yield* remote.subscribe((keys) => Queue.offer(received, keys).pipe(Effect.asVoid));
        // Initial empty wake confirms LISTEN is registered before the flip writes.
        assert.deepStrictEqual(yield* Queue.take(received), []);

        const first = yield* ShareByDefault.company(companyId).pipe(Effect.provide(fleetDatabases));
        assert.sameDeepMembers(
          first.shared.filter((resource) => resource.patchId === patchId),
          [
            { patchId, kind: "table", name: "notes" },
            { patchId, kind: "store", name: "photos" }
          ]
        );
        const delivered: string[] = [];
        while (
          !delivered.includes(`table:${patchId}:notes`) ||
          !delivered.includes(`store:${patchId}:photos`)
        ) {
          delivered.push(...(yield* Queue.take(received)));
        }
        assert.include(delivered, `table:${patchId}:notes`);
        assert.include(delivered, `store:${patchId}:photos`);

        const second = yield* ShareByDefault.company(companyId).pipe(
          Effect.provide(fleetDatabases)
        );
        assert.deepStrictEqual(second.shared, []);
        yield* Effect.sleep("150 millis");
        assert.deepStrictEqual(yield* Queue.clear(received), []);
      }).pipe(Effect.scoped, TestClock.withLive)
  );
});
