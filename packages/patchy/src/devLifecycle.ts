// @effect-diagnostics nodeBuiltinImport:off -- Detached children, birth-checked signals and append-only log descriptors are process-boundary operations.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { CliError } from "./CliError.js";
import { LocalError } from "./CliError.js";
import * as Instance from "./Instance.js";
import * as Output from "./Output.js";
import * as Preparation from "./devPreparation.js";
import { checkRepoRelease } from "./repoBuild.js";
import { safePath } from "./ManagedProject.js";
import {
  atomicJson,
  birth,
  directory,
  io,
  lock,
  logPath,
  readRecord,
  sameProcess,
  type Daemon
} from "./devState.js";

const Health = Schema.Struct({
  nonce: Schema.String,
  root: Schema.String,
  instance: Schema.String
});
const decodeHealth = Schema.decodeUnknownEffect(Health);
const decodeFailure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.String, code: Schema.optionalKey(Schema.String) })
  )
);
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

const healthy = Effect.fn("Dev.healthy")(function* (record: Daemon) {
  if (!record.url || !(yield* io("Could not inspect the dev process.", () => sameProcess(record))))
    return false;
  const url = new URL(record.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return false;
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .execute(
      HttpClientRequest.get(`${url.origin}/healthz`).pipe(
        HttpClientRequest.setHeader("x-patchy-dev", record.nonce)
      )
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status !== 200)
            return yield* new LocalError({ message: "Dev runtime is not healthy." });
          return yield* response.json;
        })
      ),
      Effect.flatMap(decodeHealth),
      Effect.map(
        (body) =>
          body.nonce === record.nonce &&
          body.root === record.root &&
          body.instance === record.instance
      ),
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.succeed(false))
    );
});

const recorded = Effect.fn("Dev.recorded")(function* (
  root: string,
  stateDir: string,
  instance: string
) {
  const record = yield* io("Could not read the local dev record.", () => readRecord(stateDir));
  if (record && (record.root !== root || record.instance !== instance))
    return yield* new LocalError({
      message: "The dev record belongs to another repo or instance. It was left untouched."
    });
  return record;
});

const report = (record: Daemon, stateDir: string) => {
  const stop = `pnpm patchy dev stop --api-url '${record.instance.replaceAll("'", "'\\''")}'`;
  return Output.report(
    {
      ok: true,
      healthy: true,
      url: record.url,
      logPath: logPath(stateDir),
      stop,
      pid: record.pid,
      release: record.release,
      identity: record.identity
    },
    [record.url!, `Log: ${logPath(stateDir)}`, `Stop: ${stop}`]
  );
};

const stopRecorded = Effect.fn("Dev.stopRecorded")(function* (record: Daemon | undefined) {
  if (!record) return;
  const signal = (name: NodeJS.Signals) =>
    io("Could not stop the local dev runtime.", async () => {
      if (await sameProcess(record)) process.kill(record.pid, name);
    });
  yield* signal("SIGTERM");
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!(yield* io("Could not inspect the dev process.", () => sameProcess(record)))) return;
    yield* Effect.sleep("100 millis");
  }
  yield* signal("SIGKILL");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(yield* io("Could not inspect the dev process.", () => sameProcess(record)))) return;
    yield* Effect.sleep("100 millis");
  }
  return yield* new LocalError({
    message: "The local dev runtime did not stop; its data was left intact."
  });
});

/** Resolve credentials only for a new session. A release or logout cannot invalidate a healthy one. */
export const start = Effect.fn("Dev.start")(function* <R>(
  cwd: string,
  token: Effect.Effect<Redacted.Redacted, CliError, R>,
  foreground: boolean
) {
  const instance = yield* Instance.Instance;
  const { root, stateDir } = yield* directory(cwd, instance.apiUrl);
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* lock(stateDir);
      const prior = yield* recorded(root, stateDir, instance.apiUrl);
      if (prior && (yield* healthy(prior))) return { record: prior, started: false };
      if (prior && (yield* io("Could not inspect the dev process.", () => sameProcess(prior))))
        return yield* new LocalError({
          message:
            "This repo's dev runtime is alive but not healthy. Read `patchy dev logs`, then `patchy dev stop`."
        });
      const credential = yield* token;
      yield* checkRepoRelease(root, credential);
      const prepared = yield* Preparation.prepare(root, credential).pipe(
        Effect.catchTags({
          DevFixtureMissing: (cause) => new LocalError({ message: cause.message, cause }),
          PlatformError: (cause) =>
            new LocalError({
              message: "Could not read the patch repo while preparing dev.",
              cause
            }),
          SchemaError: (cause) =>
            new LocalError({
              message: "The instance returned invalid declaration metadata.",
              cause
            })
        })
      );
      yield* io("Could not save local dev metadata.", async () => {
        await atomicJson(stateDir, "prepared.json", prepared);
        await fs.rm(await safePath(stateDir, "failure.json"), { force: true });
      });
      const nonce = randomUUID();
      // Write the nonce before spawning; the child may reach its entrypoint before spawn returns.
      const initial: Daemon = {
        root,
        instance: instance.apiUrl,
        release: prepared.manifest.release,
        identity: prepared.identity,
        nonce,
        pid: process.pid,
        birth: yield* io("Could not identify this process.", async () => {
          const value = await birth(process.pid);
          if (!value) throw new Error("Process identity unavailable");
          return value;
        })
      };
      yield* io("Could not write the dev startup record.", () =>
        atomicJson(stateDir, "daemon.json", initial)
      );
      const processEnv: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
        const value = yield* Config.option(Config.string(key)).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({ message: `Could not read ${key} for the dev process.`, cause })
          )
        );
        if (Option.isSome(value)) processEnv[key] = value.value;
      }
      const child = yield* io("Could not start the local dev runtime.", async () => {
        const log = await fs.open(await safePath(stateDir, "dev.log"), "a", 0o600);
        try {
          const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
          const entry = fileURLToPath(new URL(`./devChild.${extension}`, import.meta.url));
          const child = spawn(process.execPath, [...process.execArgv, entry, stateDir, nonce], {
            cwd: root,
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
            env: processEnv
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          if (!child.pid) throw new Error("Dev daemon has no PID");
          const stamp = await birth(child.pid);
          if (!stamp) throw new Error("Dev daemon exited before recording its identity");
          const record = { ...initial, pid: child.pid, birth: stamp };
          await atomicJson(stateDir, "daemon.json", record);
          child.unref();
          return record;
        } finally {
          await log.close();
        }
      });
      const waiting = Effect.gen(function* () {
        for (let attempt = 0; attempt < 240; attempt++) {
          const current = yield* recorded(root, stateDir, instance.apiUrl);
          if (current?.nonce === nonce && (yield* healthy(current))) return current;
          const failure = yield* io("Could not read the dev startup outcome.", async () => {
            try {
              return decodeFailure(
                await fs.readFile(await safePath(stateDir, "failure.json"), "utf8")
              );
            } catch (error) {
              if (missing(error)) return undefined;
              throw error;
            }
          });
          if (failure)
            return yield* new LocalError({
              message: failure.error,
              ...(failure.code === undefined ? {} : { code: failure.code })
            });
          if (!(yield* io("Could not inspect the dev process.", () => sameProcess(child))))
            return yield* new LocalError({
              message: `The dev runtime exited before becoming healthy. Read ${logPath(stateDir)}.`
            });
          yield* Effect.sleep("250 millis");
        }
        return yield* new LocalError({
          message: `The dev runtime did not become healthy. Read ${logPath(stateDir)}.`
        });
      });
      const ready = yield* waiting.pipe(
        Effect.onError(() => stopRecorded(child).pipe(Effect.orDie))
      );
      return { record: ready, started: true };
    })
  );
  yield* report(result.record, stateDir);
  if (!foreground) return;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const json = yield* Output.JsonFlag;
      // Joining an existing session is read-only; interrupting it does not stop somebody else's daemon.
      if (result.started)
        yield* Effect.addFinalizer(() => stopRecorded(result.record).pipe(Effect.orDie));
      const log = json
        ? undefined
        : yield* Effect.acquireRelease(
            io("Could not open the dev log.", () => fs.open(logPath(stateDir), "r")),
            (file) => io("Could not close the dev log.", () => file.close()).pipe(Effect.orDie)
          );
      const buffer = log ? Buffer.alloc(64 * 1024) : undefined;
      let offset = 0;
      while (yield* io("Could not inspect the dev process.", () => sameProcess(result.record))) {
        if (log && buffer) {
          offset += yield* io("Could not stream the dev log.", async () => {
            const { bytesRead } = await log.read(buffer, 0, buffer.length, offset);
            if (bytesRead > 0) {
              await new Promise<void>((resolve, reject) => {
                process.stderr.write(buffer.subarray(0, bytesRead), (error) =>
                  error ? reject(error) : resolve()
                );
              });
            }
            return bytesRead;
          });
        }
        yield* Effect.sleep("250 millis");
      }
    })
  );
});

export const manage = Effect.fn("Dev.manage")(function* (
  cwd: string,
  command: "status" | "stop" | "logs" | "reset"
) {
  const instance = yield* Instance.Instance;
  const { root, stateDir } = yield* directory(cwd, instance.apiUrl);
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* lock(stateDir);
      const record = yield* recorded(root, stateDir, instance.apiUrl);
      if (command === "status") {
        if (record && (yield* healthy(record))) return yield* report(record, stateDir);
        if (record && !(yield* io("Could not inspect the dev process.", () => sameProcess(record))))
          yield* io("Could not clear the stale dev record.", async () =>
            fs.rm(await safePath(stateDir, "daemon.json"), { force: true })
          );
        return yield* new LocalError({
          message: "No healthy dev runtime for this repo and instance. Run `patchy dev`.",
          code: "not_running"
        });
      }
      if (command === "logs") {
        const file = yield* io("Could not locate the dev log.", () =>
          safePath(stateDir, "dev.log")
        );
        const text = yield* io("Could not read the dev log.", async () => {
          try {
            return await fs.readFile(file, "utf8");
          } catch (error) {
            if (missing(error)) return "";
            throw error;
          }
        });
        return yield* Output.report({ ok: true, log: file, text }, [text || "No dev log yet."]);
      }
      yield* stopRecorded(record);
      yield* io("Could not clear stopped local dev state.", async () => {
        await fs.rm(await safePath(stateDir, "daemon.json"), { force: true });
        if (command === "reset") {
          for (const name of await fs.readdir(stateDir)) {
            if (name === "lock") continue;
            await fs.rm(await safePath(stateDir, name), { recursive: true, force: true });
          }
        }
      });
      yield* Output.report(
        {
          ok: true,
          healthy: false,
          reset: command === "reset"
        },
        [
          command === "reset"
            ? "Disposable local state reset. Published schema will be fetched from the server on the next start. Run `patchy dev` to start."
            : "Stopped. Local data retained."
        ]
      );
    })
  );
});
