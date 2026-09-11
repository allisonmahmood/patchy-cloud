import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { CURRENT_RELEASE, MANIFEST_VERSION, Release, SdkGroup, WIRE_VERSION } from "@patchy/api";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Catalog, Generated, isManagedOutputPath } from "@patchy/api";
import { Patches } from "@patchy/patches";
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
  Layer.provide(Artifact.layer),
  Layer.provideMerge(
    Generation.layer.pipe(
      Layer.provideMerge(Patches.layer.pipe(Layer.provideMerge(Fixtures.database)))
    )
  ),
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
const identity = Fixtures.identities.uploader;
const generateRequest = (manifest = Fixtures.manifest, skills: string[] = []) => ({
  release: CURRENT_RELEASE,
  manifest,
  skills
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
        columns: { title: { kind: "text" as const } },
        indexes: { byTitle: { columns: ["title"] } },
        shared: true
      };
      yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(identity.company.id);
      yield* Fixtures.record({
        ...Fixtures.publishRecord(),
        manifest: {
          ...Fixtures.manifest,
          name: "sdk-shared-source",
          tables: { contacts: definition }
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
      });
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
    })
  );
});
