import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Instance from "./Instance.js";
import * as State from "./State.js";

const services = Layer.merge(NodeFileSystem.layer, NodePath.layer);

/** A fresh worktree-shaped temp dir: `<root>/a/b` as cwd, the state dir beside it. */
const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-instance-" });
  const cwd = path.join(root, "a", "b");
  yield* fs.makeDirectory(cwd, { recursive: true });
  const stateDir = path.join(root, "state");
  return { root, cwd, stateDir };
});

const resolve = (
  cwd: string,
  options: { flag?: string; env?: Record<string, string>; stateDir: string; project?: boolean }
) =>
  Instance.make(cwd, options.project).pipe(
    Effect.provideService(Instance.ApiUrlFlag, Option.fromUndefinedOr(options.flag)),
    Effect.provide(State.layer),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: options.stateDir, ...options.env })
      )
    )
  );

it.layer(services)("Instance", (it) => {
  it.effect("walks up from cwd to the nearest .local/dev/env, which beats the environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, cwd, stateDir } = yield* scenario;
      yield* fs.writeFileString(
        path.join(cwd, "patchy.json"),
        JSON.stringify({ instance: "https://repo.test" })
      );
      yield* fs.makeDirectory(path.join(root, ".local", "dev"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".local", "dev", "env"),
        "PATCHY_API_URL=http://127.0.0.1:41234/\nPATCHY_API_TOKEN=secret\n"
      );

      const fromDev = yield* resolve(cwd, { stateDir, env: { PATCHY_API_URL: "http://env" } });
      assert.deepStrictEqual(fromDev, {
        apiUrl: "http://127.0.0.1:41234",
        source: "dev-env",
        token: Option.some(Redacted.make("secret"))
      });

      const fromFlag = yield* resolve(cwd, { stateDir, flag: "http://flag/" });
      assert.deepStrictEqual(fromFlag, {
        apiUrl: "http://flag",
        source: "flag",
        token: Option.none()
      });
    }).pipe(Effect.scoped)
  );

  it.effect("falls through env, the saved config, then the default; empty env is unset", () =>
    Effect.gen(function* () {
      const { cwd, stateDir } = yield* scenario;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(cwd, "patchy.json"), "invalid repo config");

      const fromEnv = yield* resolve(cwd, { stateDir, env: { PATCHY_API_URL: " http://env/ " } });
      assert.deepStrictEqual(fromEnv, {
        apiUrl: "http://env",
        source: "env",
        token: Option.none()
      });

      const unconfigured = yield* resolve(cwd, { stateDir, env: { PATCHY_API_URL: "" } });
      assert.deepStrictEqual(unconfigured, {
        apiUrl: Instance.DEFAULT_API_URL,
        source: "default",
        token: Option.none()
      });

      yield* Effect.gen(function* () {
        const state = yield* State.State;
        yield* state.saveConfigUrl("http://saved");
      }).pipe(
        Effect.provide(State.layer),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: stateDir }))
        )
      );
      const fromConfig = yield* resolve(cwd, { stateDir, env: { PATCHY_API_URL: "" } });
      assert.deepStrictEqual(fromConfig, {
        apiUrl: "http://saved",
        source: "config",
        token: Option.none()
      });
    }).pipe(Effect.scoped)
  );

  for (const source of ["flag", "dev-env", "env"] as const) {
    it.effect(
      `${source} must match the stored repo instance, preserving effective source and token`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { root, cwd, stateDir } = yield* scenario;
          yield* fs.writeFileString(
            path.join(cwd, "patchy.json"),
            JSON.stringify({ instance: " https://repo.test/// " })
          );
          const fromTarget = Effect.fn("InstanceTest.fromTarget")(function* (apiUrl: string) {
            if (source !== "env") {
              yield* fs.makeDirectory(path.join(root, ".local", "dev"), { recursive: true });
              yield* fs.writeFileString(
                path.join(root, ".local", "dev", "env"),
                `PATCHY_API_URL=${source === "dev-env" ? apiUrl : "https://ignored-dev.test"}\nPATCHY_API_TOKEN=seeded\n`
              );
            }
            return yield* resolve(cwd, {
              stateDir,
              project: true,
              ...(source === "flag" ? { flag: apiUrl } : {}),
              env: { PATCHY_API_URL: source === "env" ? apiUrl : "https://ignored-env.test" }
            });
          });

          const mismatch = yield* fromTarget("https://other.test/").pipe(Effect.flip);
          assert.strictEqual(mismatch._tag, "InstanceMismatch");
          assert.strictEqual(mismatch.kind, "local");
          assert.strictEqual(mismatch.code, "instance_mismatch");
          assert.include(mismatch.message, "https://repo.test");
          assert.include(mismatch.message, "https://other.test");

          const matching = yield* fromTarget("https://repo.test/");
          assert.deepStrictEqual(matching, {
            apiUrl: "https://repo.test",
            source,
            token: source === "dev-env" ? Option.some(Redacted.make("seeded")) : Option.none()
          });
        }).pipe(Effect.scoped)
    );
  }

  it.effect("uses the stored repo instance instead of the saved global choice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, stateDir } = yield* scenario;
      yield* fs.writeFileString(
        path.join(cwd, "patchy.json"),
        JSON.stringify({ instance: " https://repo.test/// " })
      );
      yield* Effect.gen(function* () {
        const state = yield* State.State;
        yield* state.saveConfigUrl("https://saved.test");
      }).pipe(
        Effect.provide(State.layer),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: stateDir }))
        )
      );
      assert.deepStrictEqual(yield* resolve(cwd, { stateDir, project: true }), {
        apiUrl: "https://repo.test",
        source: "project",
        token: Option.none()
      });
    }).pipe(Effect.scoped)
  );

  it.effect("validates the existing repo instance before considering an override", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, stateDir } = yield* scenario;
      yield* fs.writeFileString(path.join(cwd, "patchy.json"), JSON.stringify({ instance: 42 }));
      const error = yield* resolve(cwd, {
        stateDir,
        project: true,
        flag: "https://override.test"
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "LocalError");
    }).pipe(Effect.scoped)
  );

  it.effect("keeps override and fallback resolution when no repo exists", () =>
    Effect.gen(function* () {
      const { cwd, stateDir } = yield* scenario;
      assert.deepStrictEqual(yield* resolve(cwd, { stateDir, project: true }), {
        apiUrl: Instance.DEFAULT_API_URL,
        source: "default",
        token: Option.none()
      });
      assert.deepStrictEqual(
        yield* resolve(cwd, { stateDir, project: true, flag: "https://override.test/" }),
        { apiUrl: "https://override.test", source: "flag", token: Option.none() }
      );
    }).pipe(Effect.scoped)
  );

  it.effect("names mismatched instances without exposing URL credentials or query data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, stateDir } = yield* scenario;
      yield* fs.writeFileString(
        path.join(cwd, "patchy.json"),
        JSON.stringify({
          instance:
            "https://stored-user:stored-password@repo.test/api?key=stored-secret#stored-fragment"
        })
      );
      const error = yield* resolve(cwd, {
        stateDir,
        project: true,
        flag: "https://requested-user:requested-password@other.test/api?key=requested-secret#requested-fragment"
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "instance_mismatch");
      assert.include(error.message, "https://repo.test/api");
      assert.include(error.message, "https://other.test/api");
      assert.notMatch(error.message, /stored-|requested-|key=/);
      assert.notMatch(JSON.stringify(error), /stored-|requested-|key=/);
    }).pipe(Effect.scoped)
  );
});
