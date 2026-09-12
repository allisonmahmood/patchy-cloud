// @effect-diagnostics nodeBuiltinImport:off -- Exercise real Linux process exits during procfs identity reads.
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Identity } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as DevLifecycle from "./devLifecycle.js";
import * as Instance from "./Instance.js";
import * as Output from "./Output.js";
import { atomicJson, birth, directory, lock, sameProcess, type Daemon } from "./devState.js";
import { RELEASE } from "./release.js";

it.layer(NodeServices.layer)("dev process ownership", (it) => {
  it.effect("a live PID does not authenticate a stale birth record", () =>
    Effect.gen(function* () {
      const current = yield* Effect.promise(() => birth(process.pid));
      assert.isDefined(current);
      assert.isTrue(
        yield* Effect.promise(() => sameProcess({ pid: process.pid, birth: current! }))
      );
      assert.isFalse(
        yield* Effect.promise(() => sameProcess({ pid: process.pid, birth: "stale-birth" }))
      );
      if (process.platform === "linux") {
        const fs = yield* FileSystem.FileSystem;
        const stat = yield* fs.readFileString(`/proc/${process.pid}/stat`);
        const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
        // Ticks restart at boot: an old record with the same PID and ticks is not this process.
        assert.isFalse(
          yield* Effect.promise(() => sameProcess({ pid: process.pid, birth: ticks }))
        );
      }
    })
  );

  if (process.platform === "linux") {
    it.effect("identity reads survive a process exiting while procfs reads are in flight", () =>
      Effect.gen(function* () {
        for (let round = 0; round < 12; round++) {
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
                env: {},
                stdio: ["pipe", "ignore", "ignore"]
              });
              return { child, closed: once(child, "close") };
            }),
            ({ child, closed }) =>
              Effect.promise(async () => {
                await once(child, "spawn");
                const pid = child.pid!;
                const stamp = await birth(pid);
                assert.isDefined(stamp);
                const record = { pid, birth: stamp! };
                // Queue opens before termination so some procfs reads outlive the process.
                const reads = Promise.all(Array.from({ length: 64 }, () => sameProcess(record)));
                child.kill("SIGKILL");
                await reads;
                await closed;
                assert.isUndefined(await birth(pid));
                assert.isFalse(await sameProcess(record));
              }),
            ({ child, closed }) =>
              Effect.promise(async () => {
                child.kill("SIGKILL");
                await closed;
              })
          );
        }
      })
    );
  }

  it.effect(
    "healthy start and status retain the session's release and complete identity offline",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const instance = "https://instance.test";
        const { root, stateDir } = yield* directory(cwd, instance);
        const stamp = yield* Effect.promise(() => birth(process.pid));
        assert.isDefined(stamp);
        const identity = {
          user: { id: "usr_original", email: "original@example.test", name: "Original User" },
          company: { id: "cmp_original", handle: "original", name: "Original Company" },
          role: "admin" as const,
          machine: { id: "mt_original", name: "Original Machine" }
        };
        const record: Daemon = {
          root,
          instance,
          release: `${RELEASE}-previous`,
          identity: new Identity(identity),
          nonce: "session-nonce",
          pid: process.pid,
          birth: stamp!,
          url: "http://127.0.0.1:3000/dev/localdev0000"
        };
        yield* Effect.promise(() => atomicJson(stateDir, "daemon.json", record));
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            assert.strictEqual(request.url, "http://127.0.0.1:3000/healthz");
            assert.strictEqual(request.headers["x-patchy-dev"], record.nonce);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ root, instance, nonce: record.nonce })
            );
          })
        );
        yield* Effect.gen(function* () {
          yield* DevLifecycle.start(
            cwd,
            Effect.die("A healthy session must not resolve a fresh credential."),
            false
          );
          yield* DevLifecycle.manage(cwd, "status");
        }).pipe(
          Effect.provideService(Instance.Instance, {
            apiUrl: instance,
            source: "project",
            token: Option.none()
          }),
          Effect.provideService(Output.JsonFlag, true),
          Effect.provideService(HttpClient.HttpClient, client)
        );
        const expected = {
          ok: true,
          healthy: true,
          url: record.url,
          logPath: path.join(stateDir, "dev.log"),
          stop: `pnpm patchy dev stop --api-url '${instance}'`,
          pid: process.pid,
          release: record.release,
          identity
        };
        assert.deepStrictEqual(
          (yield* TestConsole.logLines).map((line) => JSON.parse(String(line))),
          [expected, expected]
        );
      }).pipe(Effect.provide(TestConsole.layer), Effect.scoped)
  );

  it.effect("a live owner excludes another command and releases its claim on exit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let entered = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lock(root);
          const contender = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* lock(root);
              entered = true;
            })
          ).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(contender));
          assert.isFalse(entered);
        })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lock(root);
          entered = true;
        })
      );
      assert.isTrue(entered);
    }).pipe(Effect.scoped)
  );

  it.effect("a stale owner can be reclaimed without removing a replacement owner's claim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const slot = path.join(root, "lock");
      yield* fs.makeDirectory(slot);
      yield* fs.writeFileString(
        path.join(slot, "stale.json"),
        JSON.stringify({ pid: process.pid, birth: "stale", nonce: "stale" })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lock(root);
          // Simulate another owner replacing the directory before the first finalizer runs.
          yield* fs.remove(slot, { recursive: true });
          yield* fs.makeDirectory(slot);
          yield* fs.writeFileString(path.join(slot, "replacement.json"), "replacement");
        })
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(slot, "replacement.json")),
        "replacement"
      );
    }).pipe(Effect.scoped)
  );
});
