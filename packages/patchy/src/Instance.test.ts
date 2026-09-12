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
  options: { flag?: string; env?: Record<string, string>; stateDir: string }
) =>
  Instance.make(cwd).pipe(
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
});
