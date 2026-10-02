import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  DeclarationMetadata,
  Identity,
  FilePage,
  PatchInventory,
  PostgresRows,
  TablePage
} from "@patchy/api";
import { Binding } from "@patchy/runtime/dev";
import { SubscriptionReads } from "@patchy/primitives";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Prepared } from "./devPreparation.js";
import * as DevResources from "./devResources.js";
import { RELEASE, MANIFEST_VERSION } from "./release.js";

const decodeMetadata = Schema.decodeUnknownEffect(DeclarationMetadata);
const decodePage = Schema.decodeUnknownEffect(TablePage);
const decodePostgresRows = Schema.decodeUnknownEffect(PostgresRows);

const decodeFiles = Schema.decodeUnknownEffect(FilePage);
it.live(
  "provisions shared fixture refs to undeclared recursive source tables without requiring target rows",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-shared-refs-" });
      const declaration = {
        kind: "sharedTable" as const,
        patchId: "refsource001",
        table: "contacts",
        id: "refsource001/contacts",
        revision: 3
      };
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {},
          files: {},
          uses: { contacts: declaration }
        },
        identity: new Identity({
          user: { id: "local-user", email: "local@example.test", name: "Local" },
          company: { id: "local-company", handle: "local", name: "Local" },
          role: "admin",
          machine: { id: "local-machine", name: "Local machine" }
        }),
        metadata: yield* decodeMetadata({
          postgres: {},
          shared: {
            contacts: {
              declaration,
              tables: {
                contacts: {
                  description: "Contacts identified by id; member links their membership.",
                  columns: { title: { kind: "text" }, member: { kind: "ref", table: "members" } },
                  indexes: {},
                  shared: true
                },
                members: {
                  description: "Members identified by id; team links their team.",
                  columns: { team: { kind: "ref", table: "teams" } },
                  indexes: {},
                  shared: false
                },
                teams: {
                  description: "Teams identified by id; lead identifies a member.",
                  columns: { lead: { kind: "ref", table: "members", optional: true } },
                  indexes: {},
                  shared: false
                }
              },
              uses: {}
            }
          }
        })
      };
      const fixture = `INSERT INTO "p_refsource001"."contacts" ("id", "title", "member")
VALUES ('invented-contact', 'Invented contact', 'missing-member');\n`;
      yield* fs.makeDirectory(path.join(root, "fixtures"));
      const fixturePath = path.join(root, "fixtures", "shared-contacts.sql");
      yield* fs.writeFileString(fixturePath, fixture);
      const resources = yield* DevResources.prepare(
        prepared,
        root,
        path.join(root, ".patchy", "dev")
      );
      const binding = Binding.Binding.of({
        ...resources.version,
        identity: {
          user: prepared.identity.user,
          company: prepared.identity.company,
          admin: prepared.identity.role === "admin"
        },
        principal: { userId: prepared.identity.user.id },
        correlationId: "shared-fixture-refs"
      });
      const row = yield* resources.handlers["shared.get"]
        .run({
          alias: "contacts",
          id: "invented-contact"
        })
        .pipe(Effect.provideService(Binding.Binding, binding));
      assert.include(row, {
        id: "invented-contact",
        title: "Invented contact",
        member: "missing-member"
      });
      const page = yield* resources.handlers["shared.list"]
        .run({
          alias: "contacts",
          index: "member",
          eq: { member: "missing-member" }
        })
        .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodePage));
      assert.deepStrictEqual<unknown>(page.rows, [row]);
      const undeclared = yield* resources.handlers["shared.get"]
        .run({
          alias: "members",
          id: "missing-member"
        })
        .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip);
      assert.propertyVal(undeclared, "_tag", "TableNotDeclared");
      assert.strictEqual(yield* fs.readFileString(fixturePath), fixture);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 30_000 }
);

it.live(
  "reloads shared store bytes, inferred media types and deletions without replacing owned data or fixtures",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-shared-store-" });
      const fixture = path.join(root, "fixtures/shared-assets");
      yield* fs.makeDirectory(path.join(fixture, "nested"), { recursive: true });
      yield* fs.writeFileString(path.join(fixture, "README.md"), "Fixture instructions");
      yield* fs.writeFile(path.join(fixture, "nested/asset.bin"), new Uint8Array([0, 255, 1]));
      yield* fs.writeFileString(
        path.join(fixture, "nested/logo.SVG"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
      );
      yield* fs.writeFileString(path.join(fixture, "removed.txt"), "Remove on restart");
      const assets = {
        kind: "sharedStore" as const,
        patchId: "refsource001",
        store: "documents",
        id: "refsource001/documents",
        revision: 1
      };
      const prepared: Prepared = {
        patchId: "localdev0000",
        identity: new Identity({
          user: { id: "local-user", email: "local@example.test", name: "Local" },
          company: { id: "local-company", handle: "local", name: "Local" },
          role: "admin",
          machine: { id: "local-machine", name: "Local machine" }
        }),
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {},
          files: { uploads: { description: "Owned files" } },
          uses: { assets }
        },
        metadata: {
          postgres: {},
          shared: {
            assets: {
              declaration: assets,
              definition: { description: "Shared documents", shared: true }
            }
          }
        }
      };
      const storeKey = `store:${assets.patchId}:${assets.store}`;
      let previousVector: Readonly<Record<string, string>> = {};
      const session = Effect.fn("test.sharedStoreSession")(function* (first: boolean) {
        const resources = yield* DevResources.prepare(
          prepared,
          root,
          path.join(root, ".patchy/dev")
        );
        const binding = Binding.Binding.of({
          ...resources.version,
          identity: {
            user: prepared.identity.user,
            company: prepared.identity.company,
            admin: prepared.identity.role === "admin"
          },
          principal: { userId: prepared.identity.user.id },
          correlationId: "shared-store-fixture"
        });
        if (first)
          yield* resources.handlers["files.put"]
            .run(
              { store: "uploads", name: "keep.txt", contentType: "text/plain" },
              new TextEncoder().encode("Owned")
            )
            .pipe(Effect.provideService(Binding.Binding, binding));
        const page = yield* resources.handlers["shared.files.list"]
          .run({ alias: "assets" })
          .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeFiles));
        for (const [name, contentType] of [
          ["nested/logo.SVG", "image/svg+xml"],
          ["nested/asset.bin", "application/octet-stream"]
        ] as const) {
          assert.include(
            page.files.find((file) => file.name === name),
            { contentType }
          );
          const metadata = yield* resources.handlers["shared.files.stat"]
            .run({ alias: "assets", name })
            .pipe(Effect.provideService(Binding.Binding, binding));
          assert.include(metadata, { name, contentType });
          const bytes = yield* resources.handlers["shared.files.get"]
            .run({ alias: "assets", name })
            .pipe(Effect.provideService(Binding.Binding, binding));
          assert.strictEqual(bytes.contentType, contentType);
        }
        const body = yield* resources.handlers["shared.files.get"]
          .run({ alias: "assets", name: "nested/asset.bin" })
          .pipe(Effect.provideService(Binding.Binding, binding));
        const owned = yield* resources.handlers["files.get"]
          .run({ store: "uploads", name: "keep.txt" })
          .pipe(Effect.provideService(Binding.Binding, binding));
        assert.strictEqual(new TextDecoder().decode(owned.bytes), "Owned");
        const reads = yield* SubscriptionReads.makeDev.pipe(
          Effect.provideContext(resources.context)
        );
        previousVector = yield* reads.revisions(prepared.identity.company.id, [storeKey]);
        return { names: page.files.map((file) => file.name), bytes: Array.from(body.bytes) };
      });
      assert.deepStrictEqual(yield* session(true).pipe(Effect.scoped), {
        names: ["nested/asset.bin", "nested/logo.SVG", "removed.txt"],
        bytes: [0, 255, 1]
      });
      yield* fs.remove(path.join(fixture, "removed.txt"));
      yield* fs.writeFile(path.join(fixture, "nested/asset.bin"), new Uint8Array([2, 0, 254]));
      assert.deepStrictEqual(yield* session(false).pipe(Effect.scoped), {
        names: ["nested/asset.bin", "nested/logo.SVG"],
        bytes: [2, 0, 254]
      });
      yield* fs.remove(path.join(fixture, "nested/asset.bin"));
      yield* fs.remove(path.join(fixture, "nested/logo.SVG"));
      const resources = yield* DevResources.prepare(prepared, root, path.join(root, ".patchy/dev"));
      const sql = yield* PgliteClient.PgliteClient.pipe(Effect.provideContext(resources.context));
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM patchy.files WHERE patch_id = ${assets.patchId}`,
        []
      );
      const reads = yield* SubscriptionReads.makeDev.pipe(Effect.provideContext(resources.context));
      assert.notDeepEqual(
        yield* reads.revisions(prepared.identity.company.id, [storeKey]),
        previousVector,
        "Removing the last fixture file must invalidate a resumed subscription."
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(fixture, "README.md")),
        "Fixture instructions"
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 30_000 }
);

it.live(
  "an unpublished patch keeps its own rows when only a shared fixture changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-fixture-owned-data-" });
      const stateDir = path.join(root, ".patchy", "dev");
      const fixturePath = path.join(root, "fixtures", "shared-contacts.sql");
      const declaration = {
        kind: "sharedTable" as const,
        patchId: "refsource001",
        table: "contacts",
        id: "refsource001/contacts",
        revision: 1
      };
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {
            notes: {
              description: "Locally created notes by id.",
              columns: { title: { kind: "text" } },
              indexes: {}
            }
          },
          files: {},
          uses: { contacts: declaration }
        },
        identity: new Identity({
          user: { id: "local-user", email: "local@example.test", name: "Local" },
          company: { id: "local-company", handle: "local", name: "Local" },
          role: "admin",
          machine: { id: "local-machine", name: "Local machine" }
        }),
        metadata: yield* decodeMetadata({
          postgres: {},
          shared: {
            contacts: {
              declaration,
              tables: {
                contacts: {
                  description: "Contacts by id.",
                  columns: { title: { kind: "text" } },
                  indexes: {},
                  shared: true
                }
              },
              uses: {}
            }
          }
        })
      };
      const contact = (title: string) =>
        fs.writeFileString(
          fixturePath,
          `INSERT INTO "p_refsource001"."contacts" ("id", "title") VALUES ('invented-contact', '${title}');\n`
        );
      const session = Effect.fn("test.fixtureOwnedData")(function* (
        current: Prepared,
        insert?: string
      ) {
        const resources = yield* DevResources.prepare(current, root, stateDir);
        const binding = Binding.Binding.of({
          ...resources.version,
          identity: {
            user: current.identity.user,
            company: current.identity.company,
            admin: current.identity.role === "admin"
          },
          principal: { userId: current.identity.user.id },
          correlationId: "fixture-owned-data"
        });
        const call = (op: keyof typeof resources.handlers, args: unknown) =>
          resources.handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
        if (insert !== undefined)
          yield* call("tables.insert", { table: "notes", row: { title: insert } });
        const notes = yield* call("tables.list", { table: "notes" }).pipe(
          Effect.flatMap(decodePage)
        );
        const contacts = yield* call("shared.list", { alias: "contacts" }).pipe(
          Effect.flatMap(decodePage)
        );
        return {
          notes: notes.rows.map((row) => row.title),
          contacts: contacts.rows.map((row) => row.title)
        };
      });
      yield* fs.makeDirectory(path.dirname(fixturePath));
      yield* contact("First contact");
      yield* session(prepared, "Keep my local work").pipe(Effect.scoped);
      yield* contact("Updated contact");
      assert.deepStrictEqual(yield* session(prepared).pipe(Effect.scoped), {
        notes: ["Keep my local work"],
        contacts: ["Updated contact"]
      });
      // Even an additive owned schema change recreates local data before the first publish.
      const changed: Prepared = {
        ...prepared,
        manifest: {
          ...prepared.manifest,
          tables: {
            notes: {
              ...prepared.manifest.tables.notes!,
              columns: {
                ...prepared.manifest.tables.notes!.columns,
                body: { kind: "text", optional: true }
              }
            }
          }
        }
      };
      assert.deepStrictEqual(yield* session(changed).pipe(Effect.scoped), {
        notes: [],
        contacts: ["Updated contact"]
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);

it.live(
  "reseeds a shared source when a failed fixture edit is reverted, keeping owned rows",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-fixture-retry-" });
      const stateDir = path.join(root, ".patchy", "dev");
      const fixturePath = path.join(root, "fixtures", "shared-contacts.sql");
      const declaration = {
        kind: "sharedTable" as const,
        patchId: "refsource001",
        table: "contacts",
        id: "refsource001/contacts",
        revision: 1
      };
      const notes = {
        description: "Locally created notes by id.",
        columns: { title: { kind: "text" as const } },
        indexes: {}
      };
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: { notes },
          files: {},
          uses: { contacts: declaration }
        },
        baseline: new PatchInventory({ schemaRevision: 1, tables: { notes }, files: {} }),
        identity: new Identity({
          user: { id: "local-user", email: "local@example.test", name: "Local" },
          company: { id: "local-company", handle: "local", name: "Local" },
          role: "admin",
          machine: { id: "local-machine", name: "Local machine" }
        }),
        metadata: yield* decodeMetadata({
          postgres: {},
          shared: {
            contacts: {
              declaration,
              tables: {
                contacts: {
                  description: "Contacts by id.",
                  columns: { title: { kind: "text" } },
                  indexes: {},
                  shared: true
                }
              },
              uses: {}
            }
          }
        })
      };
      const fixture = (column: string) =>
        fs.writeFileString(
          fixturePath,
          `INSERT INTO "p_refsource001"."contacts" ("id", "${column}") VALUES ('invented-contact', 'Initial contact');\n`
        );
      const session = Effect.fn("test.fixtureRetry")(function* (insert?: string) {
        const resources = yield* DevResources.prepare(prepared, root, stateDir);
        const binding = Binding.Binding.of({
          ...resources.version,
          identity: {
            user: prepared.identity.user,
            company: prepared.identity.company,
            admin: prepared.identity.role === "admin"
          },
          principal: { userId: prepared.identity.user.id },
          correlationId: "fixture-retry"
        });
        const call = (op: keyof typeof resources.handlers, args: unknown) =>
          resources.handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
        if (insert !== undefined)
          yield* call("tables.insert", { table: "notes", row: { title: insert } });
        const owned = yield* call("tables.list", { table: "notes" }).pipe(
          Effect.flatMap(decodePage)
        );
        const contacts = yield* call("shared.list", { alias: "contacts" }).pipe(
          Effect.flatMap(decodePage)
        );
        return {
          notes: owned.rows.map((row) => row.title),
          contacts: contacts.rows.map((row) => row.title)
        };
      });
      const expected = { notes: ["Keep my local work"], contacts: ["Initial contact"] };
      yield* fs.makeDirectory(path.dirname(fixturePath));
      yield* fixture("title");
      assert.deepStrictEqual(yield* session("Keep my local work").pipe(Effect.scoped), expected);
      yield* fixture("titel");
      const failure = yield* session().pipe(Effect.scoped, Effect.flip);
      assert.propertyVal(failure, "_tag", "SharedFixtureInvalid");
      yield* fixture("title");
      assert.deepStrictEqual(yield* session().pipe(Effect.scoped), expected);
      assert.deepStrictEqual(yield* session().pipe(Effect.scoped), expected);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);

it.live(
  "retains published columns, indexes, tables and stores across fresh, additive and recreated state",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-published-inventory-" });
      const stateDir = path.join(root, ".patchy", "dev");
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {
            contacts: {
              description: "Contacts identified by id and email.",
              columns: {
                email: { kind: "text" },
                note: { kind: "text", optional: true }
              },
              indexes: {}
            }
          },
          files: {},
          uses: {}
        },
        baseline: new PatchInventory({
          schemaRevision: 4,
          tables: {
            contacts: {
              description: "Contacts identified by id and email.",
              columns: {
                email: { kind: "text" },
                legacy: { kind: "text", default: "published default" },
                owner: { kind: "ref", table: "refsource001/members", optional: true }
              },
              indexes: { email: { columns: ["email"], unique: true } }
            },
            archive: {
              description: "Archived notes identified by id.",
              columns: { title: { kind: "text" } },
              indexes: {}
            }
          },
          files: { attachments: { description: "Attachments keyed by filename." } }
        }),
        identity: new Identity({
          user: { id: "local-user", email: "local@example.test", name: "Local" },
          company: { id: "local-company", handle: "local", name: "Local" },
          role: "admin",
          machine: { id: "local-machine", name: "Local machine" }
        }),
        metadata: { postgres: {}, shared: {} }
      };
      const exercise = Effect.fn("test.publishedInventory")(function* (
        current: Prepared,
        expected: ReadonlyArray<string>,
        email: string
      ) {
        const resources = yield* DevResources.prepare(current, root, stateDir);
        const binding = Binding.Binding.of({
          ...resources.version,
          identity: {
            user: current.identity.user,
            company: current.identity.company,
            admin: current.identity.role === "admin"
          },
          principal: { userId: current.identity.user.id },
          correlationId: "published-inventory"
        });
        const call = (op: keyof typeof resources.handlers, args: unknown) =>
          resources.handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
        const before = yield* call("tables.list", { table: "contacts" }).pipe(
          Effect.flatMap(decodePage)
        );
        assert.deepStrictEqual(before.rows.map((row) => row.email).sort(), [...expected].sort());
        const inserted = yield* call("tables.insert", { table: "contacts", row: { email } });
        assert.include(inserted, { email });
        assert.notProperty(inserted, "legacy");
        assert.propertyVal(
          yield* call("tables.insert", { table: "contacts", row: { email } }).pipe(Effect.flip),
          "_tag",
          "UniqueViolation"
        );
        const retained = yield* Effect.gen(function* () {
          const sql = yield* PgliteClient.PgliteClient;
          const columns = yield* sql<{ email: string; legacy: string; owner: string | null }>`
            SELECT email, legacy, owner FROM p_localdev0000.contacts ORDER BY email`;
          yield* sql`INSERT INTO p_localdev0000.archive (id, title) VALUES (${email}, 'Retained table')`;
          const archive = yield* sql<{ title: string }>`
            SELECT title FROM p_localdev0000.archive WHERE id = ${email}`;
          const stores = yield* sql<{ name: string }>`
            SELECT name FROM patchy.stores WHERE patch_id = 'localdev0000'`;
          return { columns, archive, stores };
        }).pipe(Effect.provideContext(resources.context));
        assert.deepStrictEqual(
          retained.columns,
          [...expected, email].sort().map((value) => ({
            email: value,
            legacy: "published default",
            owner: null
          }))
        );
        assert.deepStrictEqual(retained.archive, [{ title: "Retained table" }]);
        assert.deepStrictEqual(retained.stores, [{ name: "attachments" }]);
      });
      yield* exercise(prepared, [], "first@example.test").pipe(Effect.scoped);
      const additive: Prepared = {
        ...prepared,
        manifest: {
          ...prepared.manifest,
          tables: {
            contacts: {
              ...prepared.manifest.tables.contacts!,
              columns: {
                ...prepared.manifest.tables.contacts!.columns,
                stage: { kind: "text", optional: true }
              },
              indexes: { stage: { columns: ["stage"] } }
            }
          }
        }
      };
      yield* exercise(additive, ["first@example.test"], "second@example.test").pipe(Effect.scoped);
      const refused = yield* DevResources.prepare(
        {
          ...additive,
          manifest: {
            ...additive.manifest,
            tables: {
              contacts: {
                ...additive.manifest.tables.contacts!,
                columns: {
                  ...additive.manifest.tables.contacts!.columns,
                  email: { kind: "integer" }
                }
              }
            }
          }
        },
        root,
        stateDir
      ).pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(refused._tag, "NotAdditive");
      yield* exercise(
        additive,
        ["first@example.test", "second@example.test"],
        "after-refusal@example.test"
      ).pipe(Effect.scoped);
      yield* fs.remove(path.join(stateDir, "company"), { recursive: true });
      yield* exercise(additive, [], "reset@example.test").pipe(Effect.scoped);
      yield* exercise(
        {
          ...additive,
          manifest: {
            ...additive.manifest,
            tables: {
              contacts: {
                ...additive.manifest.tables.contacts!,
                columns: {
                  ...additive.manifest.tables.contacts!.columns,
                  note: { kind: "integer", optional: true }
                }
              }
            }
          }
        },
        [],
        "recreated@example.test"
      ).pipe(Effect.scoped);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);

it.live(
  "keeps per-connection Postgres workers alive after preparation until the resource scope closes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-postgres-dispatch-" });
      const stateDir = path.join(root, ".patchy", "dev");
      const first = {
        kind: "postgres" as const,
        id: "first-connection",
        handle: "first",
        revision: 1
      };
      const second = {
        kind: "postgres" as const,
        id: "second-connection",
        handle: "second",
        revision: 1
      };
      const snapshot = { version: 1 as const, enums: [], relations: [], exclusions: [] };
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {},
          files: {},
          uses: { first, mirror: first, second }
        },
        identity: new Identity({
          user: { id: "local-user", email: "local@example.test", name: "Local" },
          company: { id: "local-company", handle: "local", name: "Local" },
          role: "admin",
          machine: { id: "local-machine", name: "Local machine" }
        }),
        metadata: {
          postgres: {
            first: { declaration: first, snapshot },
            mirror: { declaration: first, snapshot },
            second: { declaration: second, snapshot }
          },
          shared: {}
        }
      };
      yield* fs.makeDirectory(path.join(root, "fixtures"));
      for (const handle of ["first", "second"]) {
        // A reopened worker cannot recover this session-only row from its persisted directory.
        yield* fs.writeFileString(
          path.join(root, "fixtures", `postgres-${handle}.sql`),
          `CREATE TABLE fixture_marker AS SELECT '${handle}'::text AS marker;
CREATE TEMP TABLE session_marker AS SELECT * FROM fixture_marker;`
        );
      }
      yield* Effect.gen(function* () {
        const resources = yield* DevResources.prepare(prepared, root, stateDir);
        const binding = Binding.Binding.of({
          ...resources.version,
          identity: {
            user: prepared.identity.user,
            company: prepared.identity.company,
            admin: prepared.identity.role === "admin"
          },
          principal: { userId: prepared.identity.user.id },
          correlationId: "postgres-dispatch"
        });
        // The first query proves the initialized worker survived preparation.
        // Successful queries DISCARD ALL, so later calls use the durable fixture.
        for (const [connection, table] of [
          ["first", "session_marker"],
          ["second", "session_marker"],
          ["mirror", "fixture_marker"],
          ["first", "fixture_marker"]
        ]) {
          const result = yield* resources.handlers["postgres.query"]
            .run({
              connection,
              sql: `SELECT marker FROM ${table}`,
              params: [],
              shape: { marker: { kind: "text" } }
            })
            .pipe(
              Effect.provideService(Binding.Binding, binding),
              Effect.flatMap(decodePostgresRows)
            );
          assert.deepStrictEqual(result.rows, [
            { marker: connection === "second" ? "second" : "first" }
          ]);
        }
      }).pipe(Effect.scoped);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);
