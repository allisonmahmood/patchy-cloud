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
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { CURRENT_RELEASE, MANIFEST_VERSION, Release, SdkGroup, WIRE_VERSION } from "@patchy/api";
import * as Artifact from "./Artifact.js";
import * as SdkApi from "./SdkApi.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const decodeRelease = Schema.decodeUnknownEffect(Release);
const routes = Layer.merge(
  HttpApiBuilder.layer(HttpApi.make("patchy").add(SdkGroup)).pipe(Layer.provide(SdkApi.layer)),
  SdkApi.tarballLayer
);
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provide(Artifact.layer),
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
import { executeConfig } from "patchy/executeConfig";
import { createClient, PatchyError } from "patchy/client";
import * as dev from "patchy/dev";
const manifest = await executeConfig(${JSON.stringify(path.join(dir, "patchy.config.ts"))});
if (typeof createClient !== "function" || typeof PatchyError !== "function") throw new Error("Missing client exports");
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
import { executeConfig } from "patchy/executeConfig";
import * as dev from "patchy/dev";
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

  it.effect("does not redirect old, unknown or malformed SDK paths into sign-in", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const url of [
        "/sdk/patchy-9.9.9.tgz",
        "/sdk/patchy-0.0.0.tgz",
        "/sdk/patchy.tgz",
        "/sdk/unknown/path",
        "/sdk"
      ]) {
        const response = yield* client.get(url);
        assert.strictEqual(response.status, 404, url);
        assert.strictEqual(response.headers["cache-control"], "no-store", url);
        assert.isUndefined(response.headers.location, url);
        assert.isUndefined(response.headers["set-cookie"], url);
      }
      const wrongMethod = yield* client.post(`/sdk/patchy-${CURRENT_RELEASE}.tgz`);
      assert.strictEqual(wrongMethod.status, 404);
      assert.isUndefined(wrongMethod.headers.location);
    })
  );
});
