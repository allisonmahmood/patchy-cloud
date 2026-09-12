// @effect-diagnostics nodeBuiltinImport:off -- Exercise real CLI processes, sockets, signals and no-follow filesystem boundaries.
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GenerateRequest, Identity, PatchInventory } from "@patchy/api";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { generateClient } from "../../sdk/src/generateClient.js";
import * as DevLifecycle from "./devLifecycle.js";
import * as Instance from "./Instance.js";
import * as Output from "./Output.js";
import {
  atomicJson,
  birth,
  directory,
  lock,
  readRecord,
  sameProcess,
  type Daemon
} from "./devState.js";
import { RELEASE, MANIFEST_VERSION, WIRE_VERSION } from "./release.js";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const decodeGenerate = Schema.decodeUnknownSync(GenerateRequest);
const identity = new Identity({
  user: { id: "lifecycle-user", email: "lifecycle@example.test", name: "Lifecycle" },
  company: { id: "lifecycle-company", handle: "lifecycle", name: "Lifecycle" },
  role: "admin",
  machine: { id: "lifecycle-machine", name: "Lifecycle test" }
});
const patchId = "localdev0000";
const versionId = "ver_000000000000000000000000";
const inventory = new PatchInventory({
  schemaRevision: 1,
  tables: { notes: { columns: { title: { kind: "text" } }, indexes: {} } },
  files: { attachments: {} }
});
const idleProcess =
  "require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('ready'));";
interface Running {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const subprocess = (args: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv = {}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const executablePath = yield* Config.string("PATH").pipe(Config.withDefault(""));
      const child = spawn(process.execPath, [...args], {
        cwd,
        env: {
          PATH: executablePath,
          HOME: cwd,
          PATCHY_STATE_DIR: path.join(cwd, "auth"),
          ...env
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        }
      );
      // A failed spawn can happen before the test starts awaiting its result.
      void exit.catch(() => undefined);
      return { child, exit, stdout: () => stdout, stderr: () => stderr };
    }),
    (running) =>
      Effect.promise(async () => {
        if (running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill("SIGKILL");
        await running.exit.catch(() => undefined);
      })
  );

const output = (running: Running, stream: "stdout" | "stderr", text: string) =>
  Effect.promise(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const pipe = running.child[stream]!;
        const cleanup = () => {
          pipe.off("data", check);
          running.child.off("close", closed);
          signal.removeEventListener("abort", aborted);
        };
        const check = () => {
          if (running[stream]().includes(text)) {
            cleanup();
            resolve();
          }
        };
        const closed = () => {
          cleanup();
          reject(new Error(`Child exited before ${text}: ${running.stdout()} ${running.stderr()}`));
        };
        const aborted = () => {
          cleanup();
          resolve();
        };
        pipe.on("data", check);
        running.child.once("close", closed);
        signal.addEventListener("abort", aborted, { once: true });
        check();
        if (
          !running[stream]().includes(text) &&
          (running.child.exitCode !== null || running.child.signalCode !== null)
        )
          closed();
      })
  ).pipe(Effect.timeout("20 seconds"));

const exited = (running: Running) =>
  Effect.promise(() => running.exit).pipe(Effect.timeout("12 seconds"));
const cli = (root: string, instance: string, args: ReadonlyArray<string>) =>
  subprocess(
    [path.join(packageDir, "dist/index.js"), "dev", ...args, "--api-url", instance],
    root,
    {
      PATCHY_API_TOKEN: "disposable-lifecycle-token"
    }
  );
const command = Effect.fn("test.lifecycle.command")(function* (
  root: string,
  instance: string,
  args: ReadonlyArray<string>
) {
  const running = yield* cli(root, instance, [...args, "--json"]);
  const result = yield* exited(running);
  assert.strictEqual(result.code, 0, running.stderr());
  assert.strictEqual(running.stderr(), "");
  return JSON.parse(running.stdout());
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-lifecycle-" });
  const requests: string[] = [];
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const url = request.url ?? "";
          requests.push(url);
          const respond = (body: unknown, status = 200) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          };
          if (url === "/api/release")
            return respond({
              release: RELEASE,
              package: { tarball: "/sdk/patchy.tgz", integrity: `sha512-${"A".repeat(86)}==` },
              manifestVersion: MANIFEST_VERSION,
              wireVersion: WIRE_VERSION
            });
          if (url === "/api/me") return respond(identity);
          if (url === `/api/patches/${patchId}/inventory`) return respond(inventory);
          if (url === "/api/sdk/generate") {
            try {
              const { manifest } = decodeGenerate(
                JSON.parse(Buffer.concat(chunks).toString("utf8"))
              );
              assert.deepStrictEqual(manifest.uses, {});
              return respond({
                ok: true,
                uses: [],
                metadata: { postgres: {}, shared: {} },
                files: [
                  {
                    path: "patchy/_generated/client.ts",
                    contents: generateClient({ connections: {} })
                  },
                  {
                    path: "patchy/_generated/index.json",
                    contents: JSON.stringify({
                      release: RELEASE,
                      manifestVersion: MANIFEST_VERSION,
                      uses: [],
                      skills: []
                    })
                  }
                ]
              });
            } catch (error) {
              return respond({ ok: false, error: String(error) }, 500);
            }
          }
          respond({ ok: false, error: `Unexpected fixture route: ${url}` }, 404);
        });
      })
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          })
      )
  );
  yield* Effect.promise(
    () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  );
  const instance = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  yield* fs.writeFileString(
    path.join(root, "patchy.json"),
    JSON.stringify({ instance, patch: patchId })
  );
  yield* fs.writeFileString(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "lifecycle-test",
      type: "module",
      private: true,
      devDependencies: { patchy: `${instance}/sdk/patchy.tgz` }
    })
  );
  yield* fs.writeFileString(
    path.join(root, "patchy.config.ts"),
    'import { defineConfig, table, t } from "patchy/config";\n' +
      'export default defineConfig({ name: "lifecycle-test", tier: 1, tables: { notes: table({ title: t.text() }) }, files: { attachments: {} }, uses: {} });\n'
  );
  yield* fs.writeFileString(
    path.join(root, "index.html"),
    "<!doctype html><html><head><title>Lifecycle</title></head><body>Local lifecycle</body></html>"
  );
  yield* fs.makeDirectory(path.join(root, "node_modules"));
  yield* nodeFsLink(packageDir, path.join(root, "node_modules/patchy"));
  yield* nodeFsLink(
    path.dirname(require.resolve("vite/package.json")),
    path.join(root, "node_modules/vite")
  );
  const { stateDir } = yield* directory(root, instance);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const record = yield* Effect.promise(() => readRecord(stateDir));
      if (record && (yield* Effect.promise(() => sameProcess(record)))) {
        yield* Effect.sync(() => process.kill(record.pid, "SIGKILL"));
        yield* Effect.gen(function* () {
          // Detached daemons are not children of this test: poll their real kernel identity until reaped.
          while (yield* Effect.promise(() => sameProcess(record))) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds"), Effect.orDie);
      }
    })
  );
  return { root, instance, stateDir, requests };
});
const nodeFsLink = (from: string, to: string) =>
  Effect.promise(() => nodeFs.symlink(from, to, "dir"));

const call = Effect.fn("test.lifecycle.call")(function* (url: string, op: string, args: unknown) {
  const http = yield* HttpClient.HttpClient;
  const origin = new URL(url).origin;
  const response = yield* http.execute(
    HttpClientRequest.post(`${origin}/api/runtime/call`).pipe(
      HttpClientRequest.setHeaders({
        origin,
        "x-patchy-wire": String(WIRE_VERSION),
        "x-patchy-principal": JSON.stringify({ userId: identity.user.id })
      }),
      HttpClientRequest.bodyJsonUnsafe({
        patchId,
        versionId,
        wire: WIRE_VERSION,
        principal: { userId: identity.user.id },
        op,
        args
      })
    )
  );
  const body = yield* response.json;
  assert.strictEqual(response.status, 200, JSON.stringify(body));
  return body;
});

it.live(
  "fresh CLI start is idempotent; stop preserves data and reset discards it before fetching published schema again",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, instance, stateDir, requests } = yield* fixture;
      const first = yield* command(root, instance, []);
      const record = (yield* Effect.promise(() => readRecord(stateDir)))!;
      assert.isTrue(yield* Effect.promise(() => sameProcess(record)));
      const requested = requests.length;
      assert.deepStrictEqual(yield* command(root, instance, []), first);
      assert.strictEqual(requests.length, requested);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "baseline.json")));
      yield* call(first.url, "tables.insert", {
        table: "notes",
        row: { title: "Keep until reset" }
      });
      const origin = new URL(first.url).origin;
      const http = yield* HttpClient.HttpClient;
      const uploaded = yield* http.execute(
        HttpClientRequest.put(
          `${origin}/api/runtime/files/${patchId}/${versionId}/attachments/note.txt`
        ).pipe(
          HttpClientRequest.setHeaders({
            origin,
            "x-patchy-wire": String(WIRE_VERSION),
            "x-patchy-principal": JSON.stringify({ userId: identity.user.id })
          }),
          HttpClientRequest.bodyText("Disposable file", "text/plain")
        )
      );
      assert.strictEqual(uploaded.status, 200, yield* uploaded.text);
      assert.deepStrictEqual(yield* command(root, instance, ["stop"]), {
        ok: true,
        healthy: false,
        reset: false
      });
      assert.isFalse(yield* Effect.promise(() => sameProcess(record)));
      const retained = yield* command(root, instance, []);
      assert.nestedPropertyVal(
        yield* call(retained.url, "tables.list", { table: "notes" }),
        "value.rows[0].title",
        "Keep until reset"
      );
      assert.nestedPropertyVal(
        yield* call(retained.url, "files.list", { store: "attachments" }),
        "value.files[0].name",
        "note.txt"
      );
      yield* fs.writeFileString(path.join(stateDir, "baseline.json"), "legacy disposable baseline");
      yield* fs.writeFileString(path.join(stateDir, "extra.bin"), "arbitrary disposable state");
      assert.deepStrictEqual(yield* command(root, instance, ["reset"]), {
        ok: true,
        healthy: false,
        reset: true
      });
      assert.deepStrictEqual(yield* fs.readDirectory(stateDir), []);
      const fresh = yield* command(root, instance, []);
      assert.nestedPropertyVal(
        yield* call(fresh.url, "tables.list", { table: "notes" }),
        "value.rows.length",
        0
      );
      assert.nestedPropertyVal(
        yield* call(fresh.url, "files.list", { store: "attachments" }),
        "value.files.length",
        0
      );
      assert.strictEqual(requests.filter((url) => url.endsWith("/inventory")).length, 3);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.provide(NodeServices.layer)),
  { timeout: 60_000 }
);

it.live(
  "foreground streams incremental chunks; interruption stops only a session it started and JSON remains clean",
  () =>
    Effect.gen(function* () {
      const { root, instance, stateDir } = yield* fixture;
      const owner = yield* cli(root, instance, ["--foreground"]);
      yield* output(owner, "stdout", "Stop:");
      const record = (yield* Effect.promise(() => readRecord(stateDir)))!;
      yield* Effect.promise(() =>
        nodeFs.appendFile(path.join(stateDir, "dev.log"), "first chunk without newline")
      );
      yield* output(owner, "stderr", "first chunk without newline");
      yield* Effect.promise(() =>
        nodeFs.appendFile(path.join(stateDir, "dev.log"), " and second chunk\n")
      );
      yield* output(owner, "stderr", "first chunk without newline and second chunk\n");
      const attached = yield* cli(root, instance, ["--foreground"]);
      yield* output(attached, "stderr", "first chunk without newline and second chunk\n");
      attached.child.kill("SIGINT");
      assert.strictEqual((yield* exited(attached)).code, 130);
      assert.isTrue(yield* Effect.promise(() => sameProcess(record)));
      const json = yield* cli(root, instance, ["--foreground", "--json"]);
      yield* output(json, "stdout", "\n");
      const reported = JSON.parse(json.stdout());
      assert.strictEqual(reported.pid, record.pid);
      yield* Effect.promise(() =>
        nodeFs.appendFile(path.join(stateDir, "dev.log"), "after JSON attachment\n")
      );
      yield* output(owner, "stderr", "after JSON attachment\n");
      json.child.kill("SIGINT");
      assert.strictEqual((yield* exited(json)).code, 130);
      assert.strictEqual(json.stderr(), "");
      assert.deepStrictEqual(JSON.parse(json.stdout()), reported);
      assert.isTrue(yield* Effect.promise(() => sameProcess(record)));
      owner.child.kill("SIGINT");
      assert.strictEqual((yield* exited(owner)).code, 130);
      assert.isFalse(yield* Effect.promise(() => sameProcess(record)));
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 40_000 }
);

const management = <A, E, R>(effect: Effect.Effect<A, E, R>, instance: string) =>
  effect.pipe(
    Effect.provideService(Instance.Instance, {
      apiUrl: instance,
      source: "project",
      token: Option.none()
    }),
    Effect.provideService(Output.JsonFlag, true)
  );
const processRecord = Effect.fn("test.lifecycle.processRecord")(function* (
  root: string,
  instance: string,
  running: Running
) {
  yield* output(running, "stdout", "ready");
  const pid = running.child.pid!;
  const stamp = yield* Effect.promise(() => birth(pid));
  assert.isDefined(stamp);
  const record: Daemon = {
    root,
    instance,
    release: RELEASE,
    identity,
    nonce: "owned-test",
    pid,
    birth: stamp!
  };
  return record;
});

it.live(
  "stop allows graceful cleanup and escalates a daemon that ignores SIGTERM",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const instance = "https://lifecycle.example.test";
      const { stateDir } = yield* directory(root, instance);
      // Exercise the platform grace period against real process exits, not mocked signal/timer APIs.
      for (const graceful of [true, false]) {
        const running = yield* subprocess(
          [
            "--eval",
            `process.on('SIGTERM', () => process.stdout.write('terminated\\n', () => { ${graceful ? "process.exit(0);" : ""} })); ${idleProcess}`
          ],
          root
        );
        const record = yield* processRecord(root, instance, running);
        yield* Effect.promise(() => atomicJson(stateDir, "daemon.json", record));
        yield* management(DevLifecycle.manage(root, "stop"), instance);
        assert.include(running.stdout(), "terminated\n");
        assert.deepStrictEqual(
          yield* exited(running),
          graceful ? { code: 0, signal: null } : { code: null, signal: "SIGKILL" }
        );
        assert.isFalse(yield* Effect.promise(() => sameProcess(record)));
        assert.isFalse(yield* fs.exists(path.join(stateDir, "daemon.json")));
      }
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provide(TestConsole.layer),
      Effect.provide(NodeServices.layer)
    ),
  { timeout: 15_000 }
);

it.live(
  "status clears dead and reused records; stop never signals the unrelated live process",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const instance = "https://lifecycle.example.test";
      const { stateDir } = yield* directory(root, instance);
      const dead = yield* subprocess(["--eval", idleProcess], root);
      const old = yield* processRecord(root, instance, dead);
      dead.child.kill("SIGTERM");
      yield* exited(dead);
      const unrelated = yield* subprocess(["--eval", idleProcess], root);
      const live = yield* processRecord(root, instance, unrelated);
      for (const record of [old, { ...live, birth: "reused-pid" }]) {
        yield* Effect.promise(() => atomicJson(stateDir, "daemon.json", record));
        const result = yield* management(DevLifecycle.manage(root, "status"), instance).pipe(
          Effect.result
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "not_running");
        assert.isFalse(yield* fs.exists(path.join(stateDir, "daemon.json")));
      }
      yield* Effect.promise(() =>
        atomicJson(stateDir, "daemon.json", { ...live, birth: "reused-pid" })
      );
      yield* management(DevLifecycle.manage(root, "stop"), instance);
      assert.isTrue(yield* Effect.promise(() => sameProcess(live)));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "daemon.json")));
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provide(TestConsole.layer),
      Effect.provide(NodeServices.layer)
    ),
  { timeout: 10_000 }
);

it.live(
  "reset walks only disposable state, retains its lock through reporting and releases it even after refusing a symlink",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      const instance = "https://lifecycle.example.test";
      const { stateDir } = yield* directory(root, instance);
      const other = yield* directory(root, "https://another.example.test");
      const otherRepo = yield* directory(outside, instance);
      const sentinels = [
        path.join(root, "author.txt"),
        path.join(outside, "keep.txt"),
        path.join(other.stateDir, "rows.bin"),
        path.join(otherRepo.stateDir, "rows.bin")
      ];
      for (const file of sentinels) yield* fs.writeFileString(file, "must survive");
      yield* fs.makeDirectory(path.join(stateDir, "extra/nested/lock"), { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "extra/nested/lock/row.bin"), "disposable");
      // Recursive rm must unlink nested symlinks, never follow them into another tree.
      yield* nodeFsLink(outside, path.join(stateDir, "extra/nested/escape"));
      yield* fs.writeFileString(path.join(stateDir, "baseline.json"), "legacy disposable baseline");
      let reported = false;
      const current = yield* Console.Console;
      yield* management(DevLifecycle.manage(root, "reset"), instance).pipe(
        Effect.provideService(Console.Console, {
          ...current,
          log: () => {
            assert.deepStrictEqual(readdirSync(stateDir), ["lock"]);
            assert.strictEqual(readdirSync(path.join(stateDir, "lock")).length, 1);
            reported = true;
          }
        })
      );
      assert.isTrue(reported);
      assert.deepStrictEqual(yield* fs.readDirectory(stateDir), []);
      yield* nodeFsLink(outside, path.join(stateDir, "escape"));
      const result = yield* management(DevLifecycle.manage(root, "reset"), instance).pipe(
        Effect.exit
      );
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(
        (yield* Effect.promise(() => nodeFs.lstat(path.join(stateDir, "escape")))).isSymbolicLink()
      );
      assert.isFalse(yield* fs.exists(path.join(stateDir, "lock")));
      yield* Effect.scoped(lock(stateDir));
      yield* fs.remove(path.join(stateDir, "escape"));
      for (const file of sentinels)
        assert.strictEqual(yield* fs.readFileString(file), "must survive");
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provide(TestConsole.layer),
      Effect.provide(NodeServices.layer)
    ),
  { timeout: 10_000 }
);
