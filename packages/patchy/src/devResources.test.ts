import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DeclarationMetadata,
  Identity,
  PatchInventory,
  PostgresRows,
  TablePage
} from "@patchy/api";
import { Binding } from "@patchy/runtime/dev";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { Prepared } from "./devPreparation.js";
import * as DevResources from "./devResources.js";
import { RELEASE, MANIFEST_VERSION } from "./release.js";

const decodeMetadata = Schema.decodeUnknownEffect(DeclarationMetadata);
const decodePage = Schema.decodeUnknownEffect(TablePage);
const decodePostgresRows = Schema.decodeUnknownEffect(PostgresRows);

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
                  columns: { title: { kind: "text" }, member: { kind: "ref", table: "members" } },
                  indexes: {},
                  shared: true
                },
                members: {
                  columns: { team: { kind: "ref", table: "teams" } },
                  indexes: {},
                  shared: false
                },
                teams: {
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
          role: prepared.identity.role
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
      assert.deepStrictEqual(page.rows, [row]);
      const undeclared = yield* resources.handlers["shared.get"]
        .run({
          alias: "members",
          id: "missing-member"
        })
        .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip);
      assert.strictEqual(undeclared._tag, "TableNotDeclared");
      assert.strictEqual(yield* fs.readFileString(fixturePath), fixture);
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 }
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
              columns: {
                email: { kind: "text" },
                legacy: { kind: "text", default: "published default" },
                owner: { kind: "ref", table: "refsource001/members", optional: true }
              },
              indexes: { email: { columns: ["email"], unique: true } }
            },
            archive: { columns: { title: { kind: "text" } }, indexes: {} }
          },
          files: { attachments: {} }
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
            role: current.identity.role
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
        assert.strictEqual(
          (yield* call("tables.insert", { table: "contacts", row: { email } }).pipe(Effect.flip))
            ._tag,
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
            role: prepared.identity.role
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
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 }
);
