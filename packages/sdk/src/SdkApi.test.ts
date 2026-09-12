import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { CURRENT_RELEASE, MANIFEST_VERSION, Release, SdkGroup, WIRE_VERSION } from "@patchy/api";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { Catalog, Generated, Manifest, isManagedOutputPath } from "@patchy/api";
import { Patches } from "@patchy/patches";
import { ConnectionStore } from "@patchy/integrations";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import * as Tables from "../../primitives/src/Tables.js";
import * as Fixtures from "../../patches/src/test/fixtures.js";
import * as Generation from "./Generation.js";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import * as Artifact from "./Artifact.js";
import * as SdkApi from "./SdkApi.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const decodeRelease = Schema.decodeUnknownEffect(Release);
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(HttpApi.make("patchy").add(SdkGroup)).pipe(
    Layer.provide(SdkApi.layer),
    Layer.provide(Fixtures.authorization)
  ),
  SdkApi.tarballLayer,
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      // Serving's address pattern must remain reachable beside the actual tarball layer.
      yield* router.add("GET", "/:company/:name/*", (request) =>
        Effect.succeed(HttpServerResponse.text(`patch:${request.url}`))
      );
      yield* router.add("*", "/*", HttpServerResponse.text("other route", { status: 405 }));
    })
  )
);
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(Artifact.layer),
  Layer.provideMerge(Patches.layer.pipe(Layer.provideMerge(Fixtures.database))),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_PUBLIC_BASE_URL: "https://patchy.example",
        // An environment override cannot relabel this immutable artifact.
        PATCHY_RELEASE: "9.9.9"
      })
    )
  )
);

it.layer(layer)("the packed SDK release", (it) => {
  it.effect(
    "serves the exact offline-installable package anonymously with its real sha512 integrity",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const discovery = yield* client.get("/api/release");
        assert.strictEqual(discovery.status, 200);
        assert.strictEqual(discovery.headers["cache-control"], "no-store");
        assert.isUndefined(discovery.headers["set-cookie"]);
        const release = yield* decodeRelease(yield* discovery.json);
        assert.strictEqual(release.release, CURRENT_RELEASE);
        assert.strictEqual(release.manifestVersion, MANIFEST_VERSION);
        assert.strictEqual(release.wireVersion, WIRE_VERSION);
        assert.strictEqual(
          release.package.tarball,
          `https://patchy.example/sdk/patchy-${release.release}.tgz`
        );

        const download = yield* client.get(new URL(release.package.tarball).pathname);
        assert.strictEqual(download.status, 200);
        assert.strictEqual(
          download.headers["cache-control"],
          "public, max-age=31536000, immutable"
        );
        assert.strictEqual(download.headers["content-type"], "application/octet-stream");
        assert.isUndefined(download.headers["set-cookie"]);
        const bytes = Buffer.from(yield* download.arrayBuffer);
        assert.strictEqual(
          release.package.integrity,
          `sha512-${createHash("sha512").update(bytes).digest("base64")}`
        );

        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "patchy-release-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        );
        yield* Effect.promise(() => writeFile(path.join(dir, "patchy.tgz"), bytes));
        yield* Effect.tryPromise(() =>
          exec(
            process.execPath,
            [
              path.join(repo, "node_modules/npm/bin/npm-cli.js"),
              "install",
              "--offline",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--cache",
              path.join(dir, "empty-cache"),
              "./patchy.tgz"
            ],
            { cwd: dir }
          )
        );
        const installed = yield* Effect.promise(() =>
          readFile(path.join(dir, "node_modules/patchy/package.json"), "utf8")
        );
        const manifest = JSON.parse(installed);
        assert.strictEqual(manifest.name, "patchy");
        assert.strictEqual(manifest.version, release.release);
        assert.deepStrictEqual(Object.keys(manifest.exports).sort(), [
          "./client",
          "./config",
          "./dev"
        ]);
        const cli = yield* Effect.tryPromise(() =>
          exec(
            process.execPath,
            [path.join(dir, "node_modules/patchy/dist/index.js"), "--version"],
            { cwd: dir }
          )
        );
        assert.strictEqual(cli.stdout.trim(), release.release);
        yield* Effect.promise(() => writeFile(path.join(dir, "package.json"), '{"type":"module"}'));
        yield* Effect.promise(() =>
          writeFile(
            path.join(dir, "patchy.config.ts"),
            `
import { defineConfig, table, t } from "patchy/config";
export default defineConfig({ name: "packed-config", tier: 0, tables: {
  notes: table({ title: t.text(), at: t.timestamp().default("now") })
}, files: {}, uses: {} });
`
          )
        );
        yield* Effect.promise(() =>
          mkdir(path.join(dir, "patchy/_generated"), { recursive: true })
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(dir, "patchy/_generated/index.json"),
            JSON.stringify({
              release: release.release,
              manifestVersion: release.manifestVersion,
              uses: []
            })
          )
        );
        const execution = yield* Effect.tryPromise(() =>
          exec(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
import { executeConfig } from "patchy/config";
import { createClient, PatchyError } from "patchy/client";
import * as client from "patchy/client";
import * as dev from "patchy/dev";
const manifest = await executeConfig(${JSON.stringify(path.join(dir, "patchy.config.ts"))});
if (typeof createClient !== "function" || typeof PatchyError !== "function") throw new Error("Missing client exports");
for (const name of ["createHttpTransport", "createPortTransport", "createPostMessageTransport"]) {
  if (name in client) throw new Error("Internal transport is public: " + name);
}
console.log(JSON.stringify(manifest));
`
            ],
            { cwd: dir }
          )
        );
        assert.strictEqual(JSON.parse(execution.stdout).release, release.release);
        yield* Effect.promise(() =>
          writeFile(
            path.join(dir, "consumer.ts"),
            `
import config from "./patchy.config.js";
import type { Insert, Row, Update } from "patchy/config";
import { createClient, PatchyError } from "patchy/client";
import { executeConfig } from "patchy/config";
import * as dev from "patchy/dev";
// @ts-expect-error HTTP transport is internal, not a frame API.
import { createHttpTransport } from "patchy/client";
// @ts-expect-error Port transport is internal until the broker owns its public surface.
import { createPortTransport } from "patchy/client";
// @ts-expect-error postMessage transport construction is internal.
import { createPostMessageTransport } from "patchy/client";
const inserted: Insert<typeof config, "notes"> = { title: "Saved" };
const changed: Update<typeof config, "notes"> = { title: "Changed" };
const at: Row<typeof config, "notes">["at"] = "2026-09-11T00:00:00.000Z";
void [inserted, changed, at, createClient, PatchyError, executeConfig, dev];
`
          )
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(dir, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                strict: true,
                noEmit: true,
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                lib: ["ES2022", "DOM"],
                types: []
              },
              include: ["consumer.ts", "patchy.config.ts"]
            })
          )
        );
        yield* Effect.tryPromise(() =>
          exec(
            process.execPath,
            [path.join(repo, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
            { cwd: dir }
          )
        );
      }),
    { timeout: 60_000 }
  );

  it.effect("preserves company patch addresses and leaves non-GET requests to other routes", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const url of ["/sdk/team-notes", "/sdk/team-notes/~v/1", "/other/team-notes"]) {
        const response = yield* client.get(url);
        assert.strictEqual(response.status, 200, url);
        assert.strictEqual(yield* response.text, `patch:${url}`);
      }
      const wrongMethod = yield* client.post(`/sdk/patchy-${CURRENT_RELEASE}.tgz`);
      assert.strictEqual(wrongMethod.status, 405);
      assert.strictEqual(yield* wrongMethod.text, "other route");
    })
  );
});

const decodeCatalog = Schema.decodeUnknownEffect(Catalog);
const decodeGenerated = Schema.decodeUnknownEffect(Generated);
const decodeManifest = Schema.decodeUnknownEffect(Manifest);
const identity = Fixtures.identities.uploader;
const generateRequest = (manifest = Fixtures.manifest, skills: string[] = []) => ({
  release: CURRENT_RELEASE,
  manifest,
  skills
});
const sdkOver = <A, E, R>(dependencies: Layer.Layer<A, E, R>) =>
  HttpApiTest.groups(HttpApi.make("patchy").add(SdkGroup), ["sdk"]).pipe(
    Effect.provide(Fixtures.as(identity)),
    Effect.provide(
      SdkApi.layer.pipe(Layer.provide(dependencies), Layer.provide(Fixtures.authorization))
    ),
    // Each in-memory API needs its own mutable router, not the live suite's memoized router.
    Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap)
  );

const failureSource = Effect.fn("sdk.failureSource")(function* (patchId: string) {
  yield* Fixtures.record({
    ...Fixtures.publishRecord(),
    manifest: { ...Fixtures.manifest, name: patchId },
    intent: "create",
    patchId,
    companyId: identity.company.id,
    ownerUserId: identity.user.id,
    versionId: `${patchId}-version`,
    machineTokenId: identity.machine.id,
    title: "SDK failure source",
    objectKey: `patches/${patchId}/versions/1.html`,
    contentHash: patchId,
    fileSize: 1,
    filename: null,
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null
  });
  return generateRequest({
    ...Fixtures.manifest,
    uses: { contacts: { kind: "sharedTable", patchId, table: "contacts" } }
  });
});

it.layer(layer)("SDK company generation", (it) => {
  it.effect(
    "requires bearer auth, handles primitive-free companies, and serves canonical sticky skills",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        assert.strictEqual((yield* client.get("/api/sdk/catalog")).status, 401);
        assert.strictEqual((yield* client.post("/api/sdk/generate")).status, 401);
        const catalog = yield* client.get("/api/sdk/catalog", {
          headers: { authorization: `Bearer ${identity.machine.id}` }
        });
        assert.strictEqual(catalog.status, 200);
        assert.deepStrictEqual(yield* decodeCatalog(yield* catalog.json), {
          connections: [],
          sharedTables: []
        });
        const generated = yield* client.execute(
          HttpClientRequest.post("/api/sdk/generate").pipe(
            HttpClientRequest.bearerToken(identity.machine.id),
            HttpClientRequest.bodyJsonUnsafe(
              generateRequest(Fixtures.manifest, ["patchy-postgres", "patchy-shared-tables"])
            )
          )
        );
        assert.strictEqual(generated.status, 200);
        assert.strictEqual(generated.headers["cache-control"], "private, no-store");
        const output = yield* decodeGenerated(yield* generated.json);
        assert.deepStrictEqual(output.uses, []);
        assert.isTrue(output.files.every(({ path }) => isManagedOutputPath(path)));
        assert.isFalse(output.files.some(({ path }) => path.endsWith("/manifest.json")));
        assert.isFalse(output.files.some(({ path }) => path.endsWith("/metadata.json")));
        const skillFiles = output.files.filter(({ path }) => path.startsWith(".agents/skills/"));
        assert.deepStrictEqual(skillFiles.map(({ path }) => path).sort(), [
          ".agents/skills/patchy-files/SKILL.md",
          ".agents/skills/patchy-loop/SKILL.md",
          ".agents/skills/patchy-postgres/SKILL.md",
          ".agents/skills/patchy-shared-tables/SKILL.md",
          ".agents/skills/patchy-tables/SKILL.md"
        ]);
        for (const file of skillFiles) {
          const name = file.path.split("/")[2]!;
          const canonical = yield* Effect.promise(() =>
            readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8")
          );
          assert.strictEqual(file.contents, canonical);
          assert.match(canonical, new RegExp(`^---\\nname: ${name}\\n`));
          assert.match(canonical, /\ndescription: .+/);
        }
        for (const payload of [
          { ...generateRequest(), release: "0.0.0" },
          generateRequest(Fixtures.manifest, ["patchy-removed"])
        ]) {
          const response = yield* client.execute(
            HttpClientRequest.post("/api/sdk/generate").pipe(
              HttpClientRequest.bearerToken(identity.machine.id),
              HttpClientRequest.bodyJsonUnsafe(payload)
            )
          );
          assert.strictEqual(response.status, 422);
          assert.include(yield* response.json, {
            code: payload.release === "0.0.0" ? "release_mismatch" : "invalid_manifest"
          });
        }
        const sql = yield* SqlClient.SqlClient;
        const placements =
          yield* sql`SELECT company_id FROM company_databases WHERE company_id = ${identity.company.id}`;
        assert.deepStrictEqual(placements, []);
      })
  );

  it.effect(
    "filters disconnected connections and generates their current snapshot without credential access",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const snapshot = {
          version: 1,
          relations: [
            {
              schema: "public",
              name: "contacts",
              kind: "table",
              columns: [
                {
                  name: "id",
                  nullable: false,
                  type: {
                    schema: "pg_catalog",
                    name: "int4",
                    baseSchema: "pg_catalog",
                    baseName: "int4",
                    sql: "integer",
                    kind: "base"
                  }
                }
              ],
              primaryKey: { name: "contacts_pkey", columns: ["id"] },
              foreignKeys: []
            }
          ],
          enums: [],
          exclusions: []
        };
        for (const [id, handle, status] of [
          ["sdk-connected", "warehouse", "connected"],
          ["sdk-disconnected", "archive", "disconnected"]
        ]) {
          yield* sql`INSERT INTO connections
          (id, company_id, integration, handle, description, mode, status, display, credentials,
           key_id, credential_revision, metadata_revision, created_by)
          VALUES (${id}, ${identity.company.id}, 'postgres', ${handle}, 'SDK fixture', 'company', ${status},
            ${sql.json({ host: "db.example.com", port: 5432, database: "sales", role: "reader" })},
            'not-a-valid-ciphertext', 'missing-key', 1, 4, ${identity.user.id})`;
          yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, revision, snapshot)
          VALUES (${id}, ${identity.company.id}, 4, ${sql.json(snapshot)})`;
        }
        const client = yield* HttpClient.HttpClient;
        for (const all of [false, true]) {
          const response = yield* client.get(`/api/sdk/catalog${all ? "?all=true" : ""}`, {
            headers: { authorization: `Bearer ${identity.machine.id}` }
          });
          const catalog = yield* decodeCatalog(yield* response.json);
          assert.deepStrictEqual(
            catalog.connections.map(({ handle }) => handle),
            all ? ["archive", "warehouse"] : ["warehouse"]
          );
          if (all)
            assert.deepStrictEqual(catalog.offered, [{ integration: "postgres", connected: true }]);
        }
        const response = yield* client.execute(
          HttpClientRequest.post("/api/sdk/generate").pipe(
            HttpClientRequest.bearerToken(identity.machine.id),
            HttpClientRequest.bodyJsonUnsafe({
              ...generateRequest(),
              manifest: {
                ...Fixtures.manifest,
                uses: { sales: { kind: "postgres", handle: "warehouse", id: "old", revision: 0 } }
              }
            })
          )
        );
        assert.strictEqual(response.status, 200);
        const output = yield* decodeGenerated(yield* response.json);
        assert.deepStrictEqual(output.uses, [{ alias: "sales", id: "sdk-connected", revision: 4 }]);
        assert.deepStrictEqual(output.metadata, {
          postgres: {
            sales: {
              declaration: {
                kind: "postgres",
                handle: "warehouse",
                id: "sdk-connected",
                revision: 4
              },
              snapshot
            }
          },
          shared: {}
        });
        for (const path of [
          "patchy/_generated/uses/sales.ts",
          "patchy/_generated/context/sales.md",
          "fixtures/postgres-warehouse.sql",
          ".agents/skills/patchy-postgres/SKILL.md"
        ])
          assert.isTrue(
            output.files.some((file) => file.path === path),
            path
          );
        assert.include(
          output.files.find(({ path }) => path === "fixtures/postgres-warehouse.sql")!.contents,
          "contacts"
        );
        const refused = yield* client.execute(
          HttpClientRequest.post("/api/sdk/generate").pipe(
            HttpClientRequest.bearerToken(identity.machine.id),
            HttpClientRequest.bodyJsonUnsafe({
              ...generateRequest(),
              manifest: {
                ...Fixtures.manifest,
                uses: { sales: { kind: "postgres", handle: "archive" } }
              }
            })
          )
        );
        assert.strictEqual(refused.status, 422);
        assert.include(yield* refused.json, { code: "connection_not_connected" });
      })
  );

  it.effect("reads cumulative shared inventory and hides sources the member cannot open", () =>
    Effect.gen(function* () {
      const patchId = "sdkshared001";
      const definition = {
        columns: {
          title: { kind: "text" as const },
          member: { kind: "ref" as const, table: "members" }
        },
        indexes: { byTitle: { columns: ["title"] } },
        shared: true
      };
      const members = {
        columns: { team: { kind: "ref" as const, table: "teams" } },
        indexes: {},
        shared: false
      };
      const teams = {
        columns: {
          lead: { kind: "ref" as const, table: "members", optional: true },
          external: { kind: "ref" as const, table: "sdktarget001/people", optional: true }
        },
        indexes: {},
        shared: false
      };
      yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(identity.company.id);
      const source: Patches.RecordInput = {
        ...Fixtures.publishRecord(),
        manifest: {
          ...Fixtures.manifest,
          name: "sdk-shared-source",
          tables: {
            contacts: definition,
            members,
            teams,
            unrelated: { columns: { title: { kind: "text" } }, indexes: {} }
          },
          uses: {
            people: {
              kind: "sharedTable",
              patchId: "sdktarget001",
              table: "people",
              id: "sdktarget001/people",
              revision: 1
            }
          }
        },
        intent: "create",
        patchId,
        companyId: identity.company.id,
        ownerUserId: identity.user.id,
        versionId: "sdk-shared-version",
        machineTokenId: identity.machine.id,
        title: "SDK shared source",
        objectKey: `patches/${patchId}/versions/1.html`,
        contentHash: "sdk-shared",
        fileSize: 1,
        filename: null,
        repoOrg: null,
        repoName: null,
        cliVersion: null,
        gitBranch: null,
        gitCommitSha: null,
        sourceIp: null,
        userAgent: null
      };
      yield* Fixtures.record({
        ...source,
        ...Fixtures.publishRecord(),
        patchId: "sdktarget001",
        versionId: "sdk-ref-target-version",
        objectKey: "patches/sdktarget001/versions/1.html",
        manifest: {
          ...Fixtures.manifest,
          name: "sdk-ref-target",
          tables: {
            people: { columns: { name: { kind: "text" } }, indexes: {}, shared: true }
          }
        }
      });
      yield* Fixtures.record(source);
      const platform = yield* SqlClient.SqlClient;
      // The catalog and consumers retain omitted tables; the active manifest is not their authority.
      yield* platform`UPDATE patch_versions SET manifest = ${platform.json(Fixtures.manifest)} WHERE id = 'sdk-shared-version'`;
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post("/api/sdk/generate").pipe(
          HttpClientRequest.bearerToken(Fixtures.identities.reader.machine.id),
          HttpClientRequest.bodyJsonUnsafe({
            ...generateRequest(),
            manifest: {
              ...Fixtures.manifest,
              uses: { contacts: { kind: "sharedTable", patchId, table: "contacts" } }
            }
          })
        )
      );
      assert.strictEqual(response.status, 200);
      const output = yield* decodeGenerated(yield* response.json);
      assert.deepStrictEqual(output.uses, [
        { alias: "contacts", id: `${patchId}/contacts`, revision: 1 }
      ]);
      const shared = output.metadata.shared.contacts!;
      assert.deepStrictEqual(Object.keys(shared.tables).sort(), ["contacts", "members", "teams"]);
      assert.deepStrictEqual(shared.tables.contacts!.columns, definition.columns);
      assert.deepStrictEqual(shared.tables.members, members);
      assert.deepStrictEqual(shared.tables.teams, teams);
      assert.deepStrictEqual(
        Object.values(shared.uses).map(({ id }) => id),
        ["sdktarget001/people"]
      );
      // The generated fixture schema must provision without the source's omitted use.
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const provisioner = yield* Tables.Tables;
      const replayManifest = yield* decodeManifest({
        ...Fixtures.manifest,
        tables: shared.tables,
        uses: shared.uses
      });
      yield* databases.withCompany(identity.company.id)(
        databases.withPatchLock("sdkrefreplay")(
          provisioner.provision("sdkrefreplay", replayManifest)
        )
      );
      for (const path of [
        "patchy/_generated/uses/contacts.ts",
        "patchy/_generated/context/contacts.md",
        "fixtures/shared-contacts.sql",
        ".agents/skills/patchy-shared-tables/SKILL.md"
      ])
        assert.isTrue(
          output.files.some((file) => file.path === path),
          path
        );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'test' WHERE id = ${patchId}`;
      const catalogResponse = yield* client.get("/api/sdk/catalog", {
        headers: { authorization: `Bearer ${Fixtures.identities.reader.machine.id}` }
      });
      const catalog = yield* decodeCatalog(yield* catalogResponse.json);
      assert.isFalse(catalog.sharedTables.some((table) => table.patchId === patchId));
      const refused = yield* client.execute(
        HttpClientRequest.post("/api/sdk/generate").pipe(
          HttpClientRequest.bearerToken(Fixtures.identities.reader.machine.id),
          HttpClientRequest.bodyJsonUnsafe({
            ...generateRequest(),
            manifest: {
              ...Fixtures.manifest,
              uses: { contacts: { kind: "sharedTable", patchId, table: "contacts" } }
            }
          })
        )
      );
      assert.strictEqual(refused.status, 422);
      assert.include(yield* refused.json, { code: "patch_not_openable" });
      const error = yield* Generation.generate(identity.company.id, {
        ...generateRequest(),
        manifest: {
          ...Fixtures.manifest,
          uses: { contacts: { kind: "sharedTable", patchId, table: "contacts" } }
        }
      }).pipe(Effect.flip);
      assert.instanceOf(error, Generation.PatchNotOpenable);
      if (error._tag === "SdkPatchNotOpenable")
        assert.instanceOf(error.cause, Patches.PatchNotOpenable);
    })
  );

  it.effect("keeps company capacity and unavailable metadata distinct on both SDK routes", () =>
    Effect.gen(function* () {
      const payload = yield* failureSource("sdkfailure01");
      const companies = yield* CompanyDatabases.CompanyDatabases;
      const busy = new CompanyDatabases.Busy({ resource: "company operations", limit: 4 });
      const failed = new CompanyDatabases.CompanyDatabaseError({
        companyId: identity.company.id,
        operation: "connect",
        cause: new Error(`secret-provider-diagnostic-${"x".repeat(4096)}`)
      });
      const notReady = new CompanyDatabases.CompanyDatabaseNotReady({
        companyId: identity.company.id,
        status: "claimed"
      });
      for (const cause of [busy, failed, notReady]) {
        const dependencies = Patches.layer.pipe(
          Layer.provide(
            Layer.succeed(CompanyDatabases.CompanyDatabases, {
              ...companies,
              withCompany: () => () => Effect.fail(cause)
            })
          ),
          Layer.fresh
        );
        for (const [stage, resource, operation] of [
          [
            "shared-table-list",
            identity.company.id,
            Generation.catalog(identity.company.id, false)
          ],
          [
            "shared-table",
            "sdkfailure01/contacts",
            Generation.generate(identity.company.id, payload)
          ]
        ] as const) {
          const error = yield* operation.pipe(Effect.provide(dependencies), Effect.flip);
          if (cause === busy) assert.strictEqual(error, busy);
          else {
            assert.instanceOf(error, Generation.GenerationUnavailable);
            if (error._tag === "GenerationUnavailable") {
              assert.strictEqual(error.cause, cause);
              assert.strictEqual(error.stage, stage);
              assert.strictEqual(error.resource, resource);
              assert.notInclude(error.message, "secret-provider-diagnostic");
              assert.isBelow(error.message.length, 512);
            }
          }
        }
        const api = yield* sdkOver(dependencies);
        for (const response of [
          yield* api.catalog({ query: {}, responseMode: "response-only" }),
          yield* api.generate({ payload, responseMode: "response-only" })
        ]) {
          assert.strictEqual(response.status, 503);
          assert.strictEqual(response.headers["cache-control"], "private, no-store");
          assert.include(yield* response.json, {
            ok: false,
            code: cause === busy ? "busy" : "source_unavailable"
          });
          assert.notInclude(yield* response.text, "secret-provider-diagnostic");
        }
      }
    })
  );

  it.effect(
    "treats SQL and company identity failures as defects rather than unavailable sources",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const sqlError = new SqlError.SqlError({
          reason: new SqlError.ConnectionError({ cause: new Error("private SQL diagnostics") })
        });
        const dependencies = Layer.succeed(Patches.Patches, {
          ...patches,
          find: () => Effect.fail(sqlError),
          sharedTables: () => Effect.fail(sqlError),
          sharedTable: () => Effect.fail(sqlError)
        });
        for (const operation of [
          Generation.catalog(identity.company.id, false),
          Generation.generate(identity.company.id, {
            ...generateRequest(),
            patchId: "sdksqlfail01"
          }),
          Generation.generate(
            identity.company.id,
            generateRequest({
              ...Fixtures.manifest,
              uses: {
                contacts: { kind: "sharedTable", patchId: "sdksqlfail01", table: "contacts" }
              }
            })
          )
        ]) {
          const exit = yield* operation.pipe(Effect.provide(dependencies), Effect.exit);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.isTrue(Cause.hasDies(exit.cause));
            assert.strictEqual(Cause.squash(exit.cause), sqlError);
          }
        }
        const payload = yield* failureSource("sdkidentity1");
        const companies = yield* CompanyDatabases.CompanyDatabases;
        const mismatch = new CompanyDatabases.CompanyIdentityMismatch({
          expectedCompanyId: identity.company.id,
          actualCompanyId: "another-company"
        });
        const isolated = Patches.layer.pipe(
          Layer.provide(
            Layer.succeed(CompanyDatabases.CompanyDatabases, {
              ...companies,
              withCompany: () => () => Effect.fail(mismatch)
            })
          ),
          Layer.fresh
        );
        for (const operation of [
          Generation.catalog(identity.company.id, false),
          Generation.generate(identity.company.id, payload)
        ]) {
          const exit = yield* operation.pipe(Effect.provide(isolated), Effect.exit);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.isTrue(Cause.hasDies(exit.cause));
            assert.strictEqual(Cause.squash(exit.cause), mismatch);
          }
        }
      })
  );

  it.effect("bounds connection-list diagnostics without unwrapping the storage failure", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore.ConnectionStore;
      const cause = new ConnectionStore.ConnectionStorageFailed({
        operation: "list",
        cause: Redacted.make(new Error(`private-connection-diagnostic-${"x".repeat(4096)}`))
      });
      const dependencies = Layer.succeed(ConnectionStore.ConnectionStore, {
        ...connections,
        list: () => Effect.fail(cause)
      });
      const payload = generateRequest({
        ...Fixtures.manifest,
        uses: { sales: { kind: "postgres", handle: "warehouse" } }
      });
      for (const operation of [
        Generation.catalog(identity.company.id, false),
        Generation.generate(identity.company.id, payload)
      ]) {
        const error = yield* operation.pipe(Effect.provide(dependencies), Effect.flip);
        assert.instanceOf(error, Generation.GenerationUnavailable);
        if (error._tag === "GenerationUnavailable") {
          assert.strictEqual(error.cause, cause);
          assert.strictEqual(error.stage, "connection-list");
          assert.strictEqual(error.resource, identity.company.id);
        }
      }
      const api = yield* sdkOver(dependencies);
      for (const response of [
        yield* api.catalog({ query: {}, responseMode: "response-only" }),
        yield* api.generate({ payload, responseMode: "response-only" })
      ]) {
        assert.strictEqual(response.status, 503);
        assert.include(yield* response.json, { ok: false, code: "source_unavailable" });
        const body = yield* response.text;
        assert.include(body, "connection-list");
        assert.notInclude(body, "private-connection-diagnostic");
        assert.isBelow(body.length, 512);
      }
    })
  );

  it.effect("names the selected connection revision when its metadata snapshot is missing", () =>
    Effect.gen(function* () {
      const dependencies = ConnectionStoreDev.layer([
        {
          connection: new ConnectionStore.Connection({
            id: "sdk-missing-snapshot",
            companyId: identity.company.id,
            integration: "postgres",
            handle: "warehouse",
            description: "Metadata-only fixture",
            mode: "company",
            status: "connected",
            display: { host: "db.example.com", port: 5432, database: "sales", role: "reader" },
            credentialRevision: 1,
            metadataRevision: 7,
            lastTestedAt: null,
            lastDiscoveredAt: null,
            createdBy: identity.user.id
          }),
          snapshots: []
        }
      ]);
      const payload = generateRequest({
        ...Fixtures.manifest,
        uses: { sales: { kind: "postgres", handle: "warehouse" } }
      });
      const error = yield* Generation.generate(identity.company.id, payload).pipe(
        Effect.provide(dependencies),
        Effect.flip
      );
      assert.instanceOf(error, Generation.GenerationUnavailable);
      if (error._tag === "GenerationUnavailable") {
        assert.instanceOf(error.cause, ConnectionStore.ConnectionNotFound);
        assert.strictEqual(error.stage, "connection-snapshot");
        assert.strictEqual(error.resource, "sdk-missing-snapshot@7");
      }
      const api = yield* sdkOver(dependencies);
      const response = yield* api.generate({ payload, responseMode: "response-only" });
      assert.strictEqual(response.status, 503);
      assert.include(yield* response.json, { ok: false, code: "source_unavailable" });
      assert.include(yield* response.text, "sdk-missing-snapshot@7");
    })
  );

  it.effect(
    "identifies the release skill when packaged file reads fail without leaking paths",
    () =>
      Effect.gen(function* () {
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: `/private/server-location/${"x".repeat(4096)}`
        });
        const dependencies = FileSystem.layerNoop({ readFileString: () => Effect.fail(cause) });
        const error = yield* Generation.generate(identity.company.id, generateRequest()).pipe(
          Effect.provide(dependencies),
          Effect.flip
        );
        assert.instanceOf(error, Generation.GenerationUnavailable);
        if (error._tag === "GenerationUnavailable") {
          assert.strictEqual(error.cause, cause);
          assert.strictEqual(error.stage, "release-skill");
          assert.strictEqual(error.resource, ".agents/skills/patchy-files/SKILL.md");
        }
        const api = yield* sdkOver(dependencies);
        const response = yield* api.generate({
          payload: generateRequest(),
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 503);
        assert.include(yield* response.json, { ok: false, code: "source_unavailable" });
        const body = yield* response.text;
        assert.include(body, ".agents/skills/patchy-files/SKILL.md");
        assert.notInclude(body, "/private/server-location");
        assert.isBelow(body.length, 512);
      })
  );
});
