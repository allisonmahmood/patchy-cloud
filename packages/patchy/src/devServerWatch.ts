// @effect-diagnostics nodeBuiltinImport:off -- Native directory watches discover module additions; Vite owns the authored dependency graph.
import { watch as watchDirectory, type FSWatcher } from "node:fs";
import * as path from "node:path";
import type { HandlerDescriptors, ReleaseToolchain } from "@patchy/api";
import * as Inspection from "@patchy/execution/inspection";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";
import { watchServer, type BuiltServer } from "./serverBuild.js";
import { discoverServerModules } from "./serverModules.js";

export interface ServerBuild extends BuiltServer {
  readonly modules: readonly string[];
  readonly inspect: Effect.Effect<typeof HandlerDescriptors.Type, LocalError>;
}

type Change =
  | { readonly _tag: "Sources" }
  | {
      readonly _tag: "Build";
      readonly generation: number;
      readonly result: BuiltServer | LocalError;
    }
  | LocalError;
const isLocalError = Schema.is(LocalError);

/** Consume builds serially; inspect and stage may run together, but installation awaits both. */
export const watch = Effect.fn("Dev.watchServer")(function* (
  root: string,
  toolchain: typeof ReleaseToolchain.Type,
  sharedStores: readonly string[]
) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* fs
    .makeTempDirectoryScoped({ prefix: "patchy-server-watch-" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new LocalError({ message: "Could not prepare the server build directory.", cause })
      )
    );
  const changes = yield* Queue.unbounded<Change>();
  const inspection = yield* Inspection.make().pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          code: "invalid_manifest",
          message: "Could not start server inspection.",
          cause
        })
    )
  );
  const serverDirectory = path.join(root, "server");
  let sourceWatcher: FSWatcher | undefined;
  let builder: { close(): Promise<void> } | undefined;
  let modules: readonly string[] | undefined;
  let generation = 0;
  let sourcesPending = false;
  let serverReplaced = true;
  const changed = () => {
    if (!sourcesPending) {
      sourcesPending = true;
      Queue.offerUnsafe(changes, { _tag: "Sources" });
    }
  };
  const watchError = (cause: unknown) =>
    Queue.offerUnsafe(
      changes,
      new LocalError({ message: "Could not watch server source files.", cause })
    );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      sourceWatcher?.close();
      await builder?.close();
    })
  );
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const watcher = watchDirectory(root, (_event, filename) => {
          if (filename === null || filename === "server") {
            serverReplaced = true;
            changed();
          }
        });
        watcher.on("error", watchError);
        return watcher;
      },
      catch: (cause) => new LocalError({ message: "Could not watch server source files.", cause })
    }),
    (watcher) => Effect.sync(() => watcher.close())
  );
  const rediscover = Effect.fn("Dev.watchServer.sources")(
    function* () {
      if (serverReplaced) {
        sourceWatcher?.close();
        sourceWatcher = undefined;
        if (yield* fs.exists(serverDirectory))
          sourceWatcher = yield* Effect.try({
            try: () =>
              watchDirectory(serverDirectory, { recursive: true }, changed).on("error", watchError),
            catch: (cause) =>
              new LocalError({ message: "Could not watch server source files.", cause })
          });
        serverReplaced = false;
      }
      const discovered = yield* discoverServerModules(root);
      if (
        builder !== undefined &&
        modules?.length === discovered.length &&
        modules.every((name, index) => name === discovered[index])
      )
        return false;
      if (modules !== undefined) {
        for (const name of discovered) {
          if (!modules.includes(name))
            yield* Console.log(`new server module ${name}: run pnpm patchy refresh for types`);
        }
      }
      const previous = builder;
      builder = undefined;
      const current = ++generation;
      if (previous !== undefined) yield* Effect.promise(() => previous.close());
      modules = discovered;
      builder = yield* Effect.tryPromise({
        try: () =>
          watchServer(root, discovered, toolchain, output, sharedStores, (result) => {
            Queue.offerUnsafe(changes, { _tag: "Build", generation: current, result });
          }),
        catch: (cause) =>
          isLocalError(cause)
            ? cause
            : new LocalError({ message: "Could not start the server build watcher.", cause })
      });
      return true;
    },
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new LocalError({ message: "Could not inspect server source files.", cause }))
    })
  );
  changed();
  return Effect.gen(function* (): Effect.fn.Return<ServerBuild, LocalError, FileSystem.FileSystem> {
    while (true) {
      const change = yield* Queue.take(changes);
      if (isLocalError(change)) return yield* change;
      if (change._tag === "Sources") {
        sourcesPending = false;
        yield* rediscover();
        continue;
      }
      if (change.generation !== generation) continue;
      // A module may have appeared during compilation. Never publish the stale module list.
      if (yield* rediscover()) continue;
      if (isLocalError(change.result)) return yield* change.result;
      const built = change.result;
      return {
        ...built,
        modules: modules!,
        inspect: inspection.inspect(built.server).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                code: "invalid_manifest",
                message:
                  "Could not inspect the server bundle. Its modules must load and export only valid handlers; the last successful binding stays served.",
                cause
              })
          )
        )
      };
    }
  });
});
