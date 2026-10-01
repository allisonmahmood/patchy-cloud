import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
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
import { Generated, Manifest, isManagedOutputPath } from "@patchy/api";
import { Patches } from "@patchy/patches";
import { ConnectionStore } from "@patchy/integrations";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { contentHash } from "../../core/src/index.js";
import * as Tables from "../../primitives/src/Tables.js";
import * as Fixtures from "../../patches/src/test/fixtures.js";
import { registry } from "../../limits/src/registry.js";
import type { SdkCapability } from "./sdkCapabilities.js";
import * as Generation from "./Generation.js";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import * as Artifact from "./Artifact.js";
import * as SdkApi from "./SdkApi.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const decodeRelease = Schema.decodeUnknownEffect(Release);
const artifactDirectory = fileURLToPath(new URL("../artifacts/", import.meta.url));
const artifactStore = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-sdk-store-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: directory }))
      )
    );
  })
).pipe(Layer.provideMerge([NodeFileSystem.layer, NodePath.layer]));

// Keep the production artifact location fixed while exercising real isolated files.
const loadArtifact = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const relocate = (file: string) =>
    file.startsWith(artifactDirectory)
      ? path.join(directory, path.relative(artifactDirectory, file))
      : file;
  return yield* Artifact.make.pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      readFile: (file, ...options) => fs.readFile(relocate(file), ...options),
      readFileString: (file, ...options) => fs.readFileString(relocate(file), ...options)
    }),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: "https://patchy.example" })
    )
  );
});
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
const restartedArtifact = <A, E, R>(directory: string, action: Effect.Effect<A, E, R>) =>
  action.pipe(
    Effect.provide(
      Layer.fresh(
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(Layer.effect(Artifact.Artifact, loadArtifact(directory))),
          Layer.provideMerge(NodeHttpServer.layerTest)
        )
      ),
      { local: true }
    )
  );
const discoverRelease = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/api/release");
  assert.strictEqual(response.status, 200);
  return yield* decodeRelease(yield* response.json);
});
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(Artifact.layer),
  Layer.provideMerge(artifactStore),
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
          release.package.tarball,
          `https://patchy.example/sdk/patchy-${release.release}-${createHash("sha256").update(bytes).digest("hex")}.tgz`
        );
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
  notes: table("Notes identified by id; at is an ISO timestamp.", { title: t.text(), at: t.timestamp().default("now") })
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
for (const entry of ["patchy/preact/debug", "patchy/preact/runtime", "patchy/dist/index.js"]) {
  try {
    import.meta.resolve(entry);
    throw new Error("Internal entry is importable: " + entry);
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
}
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
      const artifact = yield* Artifact.Artifact;
      const wrongMethod = yield* client.post(new URL(artifact.release.package.tarball).pathname);
      assert.strictEqual(wrongMethod.status, 405);
      assert.strictEqual(yield* wrongMethod.text, "other route");
    })
  );

  it.effect("refuses unknown and malformed archives without returning the current bytes", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const name of [
        `patchy-${CURRENT_RELEASE}-${"0".repeat(64)}.tgz`,
        `patchy-${CURRENT_RELEASE}.tgz`,
        `patchy-${CURRENT_RELEASE}-${"A".repeat(64)}.tgz`,
        `patchy-${CURRENT_RELEASE}-not-a-digest.tgz`
      ]) {
        const response = yield* client.get(`/sdk/${name}`);
        assert.strictEqual(response.status, 404, name);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.strictEqual((yield* response.arrayBuffer).byteLength, 0);
      }
    })
  );

  it.effect("retains advertised archives after a same-version repack prunes local copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const current = yield* Artifact.Artifact;
      const filename = path.basename(new URL(current.release.package.tarball).pathname);
      const original = Buffer.from(yield* current.get(filename));
      const repacked = Buffer.from(original);
      // A different gzip timestamp preserves the package while changing the packed bytes.
      repacked[4] = repacked[4]! ^ 1;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-sdk-repack-" });
      const source = path.join(workspace, "packages/patchy/artifacts");
      const directory = path.join(workspace, "packages/sdk/artifacts");
      const copyScript = path.join(workspace, "scripts/copy-sdk-artifact.mjs");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.makeDirectory(path.dirname(copyScript), { recursive: true });
      yield* fs.copyFile(path.join(repo, "scripts/copy-sdk-artifact.mjs"), copyScript);
      yield* fs.writeFileString(path.join(directory, "notes.txt"), "Not a generated archive.");
      const stage = Effect.tryPromise(() => exec(process.execPath, [copyScript]));
      const metadata = JSON.parse(
        yield* fs.readFileString(path.join(artifactDirectory, "release.json"))
      );
      const pack = Effect.fn(function* (bytes: Uint8Array) {
        const digest = createHash("sha256").update(bytes).digest("hex");
        const filename = `patchy-${CURRENT_RELEASE}-${digest}.tgz`;
        yield* fs.writeFile(path.join(source, filename), bytes);
        yield* fs.writeFileString(
          path.join(source, "release.json"),
          JSON.stringify({
            ...metadata,
            digest,
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
          })
        );
        return filename;
      });
      yield* pack(original);
      yield* stage;
      const first = yield* restartedArtifact(directory, discoverRelease);
      yield* fs.remove(path.join(source, filename));
      const nextFilename = yield* pack(repacked);
      yield* stage;
      assert.deepStrictEqual((yield* fs.readDirectory(directory)).sort(), [
        "notes.txt",
        nextFilename,
        "release.json"
      ]);
      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, "notes.txt")),
        "Not a generated archive."
      );
      const second = yield* restartedArtifact(
        directory,
        Effect.gen(function* () {
          const second = yield* discoverRelease;
          const client = yield* HttpClient.HttpClient;
          assert.strictEqual(second.release, first.release);
          assert.notStrictEqual(second.package.tarball, first.package.tarball);
          for (const [release, expected] of [
            [first, original],
            [second, repacked]
          ] as const) {
            const response = yield* client.get(new URL(release.package.tarball).pathname);
            assert.strictEqual(response.status, 200);
            assert.strictEqual(
              response.headers["cache-control"],
              "public, max-age=31536000, immutable"
            );
            const bytes = Buffer.from(yield* response.arrayBuffer);
            assert.deepStrictEqual(bytes, expected);
            assert.strictEqual(
              release.package.integrity,
              `sha512-${createHash("sha512").update(bytes).digest("base64")}`
            );
          }
          return second;
        })
      );
      // A replica that started before the repack must also see the newly advertised URL.
      const client = yield* HttpClient.HttpClient;
      const newDownload = yield* client.get(new URL(second.package.tarball).pathname);
      assert.strictEqual(newDownload.status, 200);
      assert.deepStrictEqual(Buffer.from(yield* newDownload.arrayBuffer), repacked);
    })
  );

  it.effect(
    "repairs the current archive before discovery despite corrupt historical archives",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ContentStore.ContentStore;
        const current = yield* Artifact.Artifact;
        const filename = path.basename(new URL(current.release.package.tarball).pathname);
        const bytes = Buffer.from(yield* current.get(filename));
        bytes[4] = bytes[4]! ^ 2;
        const digest = createHash("sha256").update(bytes).digest("hex");
        const currentFilename = `patchy-${CURRENT_RELEASE}-${digest}.tgz`;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-sdk-repair-" });
        const metadata = JSON.parse(
          yield* fs.readFileString(path.join(artifactDirectory, "release.json"))
        );
        yield* fs.writeFile(path.join(directory, currentFilename), bytes);
        yield* fs.writeFileString(
          path.join(directory, "release.json"),
          JSON.stringify({
            ...metadata,
            digest,
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
          })
        );
        const advertised = yield* loadArtifact(directory);
        const corrupted = Buffer.from("corrupt archive");
        yield* store.putBytes(`sdk/${currentFilename}`, corrupted);
        const historical = Buffer.from(bytes);
        historical[4] = historical[4]! ^ 1;
        const historicalFilename = `patchy-${CURRENT_RELEASE}-${createHash("sha256").update(historical).digest("hex")}.tgz`;
        yield* store.putBytes(`sdk/${historicalFilename}`, corrupted);
        yield* fs.writeFile(path.join(directory, historicalFilename), corrupted);

        yield* restartedArtifact(
          directory,
          Effect.gen(function* () {
            const release = yield* discoverRelease;
            assert.deepStrictEqual(release, advertised.release);
            const client = yield* HttpClient.HttpClient;
            const repaired = yield* client.get(new URL(release.package.tarball).pathname);
            assert.strictEqual(repaired.status, 200);
            assert.deepStrictEqual(Buffer.from(yield* repaired.arrayBuffer), bytes);
            assert.deepStrictEqual(
              Buffer.from(yield* store.getBytes(`sdk/${currentFilename}`)),
              bytes
            );
            const corrupt = yield* client.get(`/sdk/${historicalFilename}`);
            assert.strictEqual(corrupt.status, 503);
            assert.strictEqual(corrupt.headers["cache-control"], "private, no-store");
            assert.strictEqual((yield* corrupt.arrayBuffer).byteLength, 0);
          })
        );
      })
  );

  it.effect("refuses startup with a structured failure when current retention fails", () =>
    Effect.gen(function* () {
      const current = yield* Artifact.Artifact;
      const store = yield* ContentStore.ContentStore;
      const key = `sdk/${path.basename(new URL(current.release.package.tarball).pathname)}`;
      for (const cause of [
        new ContentStore.InvalidObjectKey({ key }),
        new ContentStore.StoreUnavailable({
          operation: "put",
          key,
          cause: new Error("private storage diagnostic")
        })
      ]) {
        const failure = yield* loadArtifact(artifactDirectory).pipe(
          Effect.provide(
            Layer.succeed(ContentStore.ContentStore, {
              ...store,
              putBytes: () => Effect.fail(cause)
            })
          ),
          Effect.flip
        );
        assert.strictEqual(failure._tag, "ArtifactRetentionFailed");
        if (failure._tag === "ArtifactRetentionFailed") {
          assert.strictEqual(failure.key, key);
          assert.strictEqual(failure.cause, cause);
          assert.notInclude(failure.message, "private storage diagnostic");
        }
      }
    })
  );

  it.effect("rejects current metadata that disagrees with the archive's digest or integrity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const current = yield* Artifact.Artifact;
      const filename = path.basename(new URL(current.release.package.tarball).pathname);
      const bytes = yield* current.get(filename);
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-sdk-invalid-" });
      const metadata = JSON.parse(
        yield* fs.readFileString(path.join(artifactDirectory, "release.json"))
      );
      const wrongDigest = "0".repeat(64);
      yield* fs.writeFile(
        path.join(directory, `patchy-${CURRENT_RELEASE}-${wrongDigest}.tgz`),
        bytes
      );
      yield* fs.writeFileString(
        path.join(directory, "release.json"),
        JSON.stringify({ ...metadata, digest: wrongDigest })
      );
      const digestError = yield* loadArtifact(directory).pipe(Effect.flip);
      assert.strictEqual(digestError._tag, "ArtifactMismatch");
      if (digestError._tag === "ArtifactMismatch") assert.strictEqual(digestError.field, "digest");
      yield* fs.writeFile(path.join(directory, filename), bytes);
      yield* fs.writeFileString(
        path.join(directory, "release.json"),
        JSON.stringify({ ...metadata, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` })
      );
      const integrityError = yield* loadArtifact(directory).pipe(Effect.flip);
      assert.strictEqual(integrityError._tag, "ArtifactMismatch");
      if (integrityError._tag === "ArtifactMismatch")
        assert.strictEqual(integrityError.field, "integrity");
    })
  );
});

const decodeGenerated = Schema.decodeUnknownEffect(Generated);
const decodeManifest = Schema.decodeUnknownEffect(Manifest);
const identity = Fixtures.identities.uploader;
const generateRequest = (manifest = Fixtures.manifest, skills: string[] = []) => ({
  release: CURRENT_RELEASE,
  manifest,
  serverModules: [],
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
    contentHash: contentHash(patchId),
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
  it.effect("refuses module paths and invalid stems before generating imports", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const serverModules of [["nested/leads"], ["../outside"], ["leads.ts"], ["9leads"]]) {
        const response = yield* client.execute(
          HttpClientRequest.post("/api/sdk/generate").pipe(
            HttpClientRequest.bearerToken(identity.machine.id),
            HttpClientRequest.bodyJsonUnsafe({ ...generateRequest(), serverModules })
          )
        );
        assert.strictEqual(response.status, 400);
      }
    })
  );
  it.effect("refuses a manifest with unknown fields instead of stripping them", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const manifest = {
        ...Fixtures.manifest,
        tables: {
          notes: {
            description: "Notes identified by their row id.",
            columns: { title: { kind: "text", optionall: true } },
            indexes: {}
          }
        }
      };
      const response = yield* client.execute(
        HttpClientRequest.post("/api/sdk/generate").pipe(
          HttpClientRequest.bearerToken(identity.machine.id),
          HttpClientRequest.bodyJsonUnsafe(generateRequest(manifest as typeof Fixtures.manifest))
        )
      );
      assert.strictEqual(response.status, 400);
      assert.deepStrictEqual(yield* response.json, {
        ok: false,
        error: "Invalid generate request field: manifest."
      });
    })
  );
  it.effect(
    "requires bearer auth, handles primitive-free companies, and retains installed skills",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        assert.strictEqual((yield* client.post("/api/sdk/generate")).status, 401);
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
    "selects page and server skills by tier, with only the server skill removed on downgrade",
    () =>
      Effect.gen(function* () {
        const api = yield* sdkOver(Layer.empty);
        for (const tier of [0, 1, 2] as const) {
          const output = yield* api.generate({
            payload: { ...generateRequest(), manifest: { ...Fixtures.manifest, tier } }
          });
          assert.strictEqual(
            output.files.some(({ path }) => path === ".agents/skills/patchy-preact/SKILL.md"),
            tier !== 0
          );
          assert.strictEqual(
            output.files.some(({ path }) => path === ".agents/skills/patchy-server/SKILL.md"),
            tier === 2
          );
          assert.isFalse(output.files.some(({ path }) => path.startsWith("src/")));
        }
        const downgraded = yield* api.generate({
          payload: generateRequest(Fixtures.manifest, ["patchy-preact", "patchy-server"])
        });
        assert.isTrue(
          downgraded.files.some(({ path }) => path === ".agents/skills/patchy-preact/SKILL.md")
        );
        assert.isFalse(
          downgraded.files.some(({ path }) => path === ".agents/skills/patchy-server/SKILL.md")
        );
      })
  );

  it.effect("generates a member-only patch without external resource stamps or fixtures", () =>
    Effect.gen(function* () {
      const api = yield* sdkOver(Layer.empty);
      const output = yield* api.generate({
        payload: generateRequest({
          ...Fixtures.manifest,
          tier: 1,
          uses: { members: { kind: "members" } }
        })
      });
      assert.deepStrictEqual(output.uses, []);
      assert.deepStrictEqual(output.metadata, { postgres: {}, shared: {} });
      assert.isFalse(output.files.some(({ path }) => path.startsWith("fixtures/")));
      assert.isTrue(
        output.files.some(({ path }) => path === ".agents/skills/patchy-members/SKILL.md")
      );
      const index = JSON.parse(
        output.files.find(({ path }) => path === "patchy/_generated/index.json")!.contents
      );
      assert.deepStrictEqual(index.uses, []);
      const removed = yield* api.generate({
        payload: generateRequest(Fixtures.manifest, ["patchy-members"])
      });
      assert.isFalse(
        removed.files.some(({ path }) => path === ".agents/skills/patchy-members/SKILL.md")
      );
    })
  );

  it.effect("renders capability runtime limits consistently with the generated catalogue", () =>
    Effect.gen(function* () {
      const api = yield* sdkOver(Layer.empty);
      const output = yield* api.generate({
        payload: generateRequest({ ...Fixtures.manifest, tier: 1 })
      });
      const loop = output.files.find(
        ({ path }) => path === ".agents/skills/patchy-loop/SKILL.md"
      )!.contents;
      const index = JSON.parse(
        output.files.find(({ path }) => path === "patchy/_generated/index.json")!.contents
      ) as { capabilities: SdkCapability[] };
      for (const capability of index.capabilities) {
        const rendered = loop.split("\n").find((line) => line.startsWith(`- ${capability.name}.`));
        assert.isDefined(rendered, capability.id);
        for (const entrypoint of capability.entrypoints) assert.include(rendered!, entrypoint);
        assert.include(rendered!, capability.runs);
        assert.include(rendered!, capability.limits);
      }
      for (const [id, expectedBytes] of [
        [
          "primitives.tables",
          [registry["runtime.row.bytes"].default, registry["runtime.batch.bytes"].default]
        ],
        ["primitives.files", [registry["runtime.file.bytes"].default]],
        ["integrations.postgres", [registry["runtime.result.bytes"].default]]
      ] as const) {
        const capability = index.capabilities.find((entry) => entry.id === id)!;
        assert.deepStrictEqual(
          [...capability.limits.matchAll(/(\d+) MiB/g)].map(
            (match) => Number(match[1]) * 1024 * 1024
          ),
          expectedBytes,
          id
        );
      }
    })
  );

  it.effect("fails generation when the loop template loses its capability marker", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dependencies = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        readFileString: (path, encoding) =>
          fs
            .readFileString(path, encoding)
            .pipe(
              Effect.map((contents) =>
                path.endsWith("/patchy-loop/SKILL.md")
                  ? contents.replace("<!-- sdk-capabilities -->", "")
                  : contents
              )
            )
      });
      const error = yield* Generation.generate(identity.company.id, generateRequest()).pipe(
        Effect.provide(dependencies),
        Effect.flip
      );
      assert.instanceOf(error, Generation.GenerationUnavailable);
      if (error._tag === "GenerationUnavailable") {
        assert.strictEqual(error.stage, "release-skill-template");
        assert.strictEqual(error.resource, ".agents/skills/patchy-loop/SKILL.md");
      }
      const api = yield* sdkOver(dependencies);
      const response = yield* api.generate({
        payload: generateRequest(),
        responseMode: "response-only"
      });
      assert.strictEqual(response.status, 503);
      assert.include(yield* response.json, { ok: false, code: "source_unavailable" });
      assert.include(yield* response.text, ".agents/skills/patchy-loop/SKILL.md");
    })
  );

  it.effect(
    "generates the current connection snapshot without credential access and rejects disconnected connections",
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

  it.effect(
    "generates cumulative shared inventory and rejects sources the member cannot open",
    () =>
      Effect.gen(function* () {
        const patchId = "sdkshared001";
        const definition = {
          description: "Contacts identified by id; member links their membership.",
          columns: {
            title: { kind: "text" as const },
            member: { kind: "ref" as const, table: "members" }
          },
          indexes: { byTitle: { columns: ["title"] } },
          shared: true
        };
        const members = {
          description: "Members identified by id; team links their team.",
          columns: { team: { kind: "ref" as const, table: "teams" } },
          indexes: {},
          shared: false
        };
        const teams = {
          description: "Teams identified by id; lead identifies a member.",
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
            files: {
              logos: { description: "Company logos keyed by filename.", shared: true }
            },
            tables: {
              contacts: definition,
              members,
              teams,
              unrelated: {
                description: "Unrelated records identified by id.",
                columns: { title: { kind: "text" } },
                indexes: {}
              }
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
          contentHash: contentHash("sdk-shared"),
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
              people: {
                description: "People identified by id.",
                columns: { name: { kind: "text" } },
                indexes: {},
                shared: true
              }
            }
          }
        });
        yield* Fixtures.record(source);
        const platform = yield* SqlClient.SqlClient;
        // Consumers retain omitted tables; the active manifest is not their authority.
        yield* platform`UPDATE patch_versions SET manifest = ${platform.json(Fixtures.manifest)} WHERE id = 'sdk-shared-version'`;
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.post("/api/sdk/generate").pipe(
            HttpClientRequest.bearerToken(Fixtures.identities.reader.machine.id),
            HttpClientRequest.bodyJsonUnsafe({
              ...generateRequest(),
              manifest: {
                ...Fixtures.manifest,
                uses: {
                  contacts: { kind: "sharedTable", patchId, table: "contacts" },
                  assets: { kind: "sharedStore", patchId, store: "logos" }
                }
              }
            })
          )
        );
        assert.strictEqual(response.status, 200);
        const output = yield* decodeGenerated(yield* response.json);
        assert.deepStrictEqual(output.uses, [
          { alias: "contacts", id: `${patchId}/contacts`, revision: 1 },
          { alias: "assets", id: `${patchId}/logos`, revision: 1 }
        ]);
        assert.deepStrictEqual(output.metadata.shared.assets, {
          declaration: {
            kind: "sharedStore",
            patchId,
            store: "logos",
            id: `${patchId}/logos`,
            revision: 1
          },
          definition: { description: "Company logos keyed by filename.", shared: true }
        });
        const shared = output.metadata.shared.contacts!;
        if (!("tables" in shared)) throw new Error("Expected shared table metadata.");
        assert.deepStrictEqual(Object.keys(shared.tables).sort(), ["contacts", "members", "teams"]);
        assert.deepStrictEqual(shared.tables.contacts!.columns, definition.columns);
        assert.deepStrictEqual(shared.tables.members, members);
        assert.deepStrictEqual(shared.tables.teams, teams);
        assert.deepStrictEqual(
          Object.values(shared.uses).flatMap((declaration) =>
            declaration.kind === "members" ? [] : [declaration.id]
          ),
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
            uses: { assets: { kind: "sharedStore", patchId, store: "logos" } }
          }
        }).pipe(Effect.flip);
        assert.instanceOf(error, Generation.PatchNotOpenable);
        if (error._tag === "SdkPatchNotOpenable") {
          assert.instanceOf(error.cause, Patches.PatchNotOpenable);
          assert.strictEqual(error.store, "logos");
          assert.isUndefined(error.table);
        }
      })
  );

  it.effect("keeps company capacity and unavailable metadata distinct during generation", () =>
    Effect.gen(function* () {
      const payload = yield* failureSource("sdkfailure01");
      const companies = yield* CompanyDatabases.CompanyDatabases;
      const busy = new CompanyDatabases.Busy({
        resource: "company operations",
        limitId: "company.connections",
        scope: "company",
        value: 4,
        retryAfterSeconds: 1
      });
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
        const error = yield* Generation.generate(identity.company.id, payload).pipe(
          Effect.provide(dependencies),
          Effect.flip
        );
        if (cause === busy) assert.strictEqual(error, busy);
        else {
          assert.instanceOf(error, Generation.GenerationUnavailable);
          if (error._tag === "GenerationUnavailable") {
            assert.strictEqual(error.cause, cause);
            assert.strictEqual(error.stage, "shared-table");
            assert.strictEqual(error.resource, "sdkfailure01/contacts");
            assert.notInclude(error.message, "secret-provider-diagnostic");
            assert.isBelow(error.message.length, 512);
          }
        }
        const api = yield* sdkOver(dependencies);
        const response = yield* api.generate({ payload, responseMode: "response-only" });
        assert.strictEqual(response.status, 503);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.include(yield* response.json, {
          ok: false,
          code: cause === busy ? "busy" : "source_unavailable"
        });
        assert.notInclude(yield* response.text, "secret-provider-diagnostic");
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
          sharedTable: () => Effect.fail(sqlError)
        });
        for (const operation of [
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
        const exit = yield* Generation.generate(identity.company.id, payload).pipe(
          Effect.provide(isolated),
          Effect.exit
        );
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(Cause.hasDies(exit.cause));
          assert.strictEqual(Cause.squash(exit.cause), mismatch);
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
      const error = yield* Generation.generate(identity.company.id, payload).pipe(
        Effect.provide(dependencies),
        Effect.flip
      );
      assert.instanceOf(error, Generation.GenerationUnavailable);
      if (error._tag === "GenerationUnavailable") {
        assert.strictEqual(error.cause, cause);
        assert.strictEqual(error.stage, "connection-list");
        assert.strictEqual(error.resource, identity.company.id);
      }
      const api = yield* sdkOver(dependencies);
      const response = yield* api.generate({ payload, responseMode: "response-only" });
      assert.strictEqual(response.status, 503);
      assert.include(yield* response.json, { ok: false, code: "source_unavailable" });
      const body = yield* response.text;
      assert.include(body, "connection-list");
      assert.notInclude(body, "private-connection-diagnostic");
      assert.isBelow(body.length, 512);
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
