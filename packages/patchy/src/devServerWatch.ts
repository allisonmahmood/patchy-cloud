import type { HandlerDescriptors, ReleaseToolchain } from "@patchy/api";
import * as Inspection from "@patchy/execution/inspection";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { LocalError } from "./CliError.js";
import * as DirectoryWatch from "./DirectoryWatch.js";
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
  const path = yield* Path.Path;
  const directories = yield* DirectoryWatch.DirectoryWatch;
  const scope = yield* Effect.scope;
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
  let sourceWatch: Scope.Closeable | undefined;
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
  const watchError = (cause: PlatformError.PlatformError) =>
    Queue.offerUnsafe(
      changes,
      new LocalError({ message: "Could not watch server source files.", cause })
    );
  yield* Effect.addFinalizer(() => Effect.promise(async () => await builder?.close()));
  // Directory watches discover added and removed modules; Vite watches what they import.
  yield* directories
    .watch(
      root,
      { recursive: false },
      {
        change: (filename) => {
          if (filename === null || filename === "server") {
            serverReplaced = true;
            changed();
          }
        },
        error: watchError
      }
    )
    .pipe(
      Effect.mapError(
        (cause) => new LocalError({ message: "Could not watch server source files.", cause })
      )
    );
  const rediscover = Effect.fn("Dev.watchServer.sources")(function* () {
    if (serverReplaced) {
      // Clear the flag before any work, so a replacement reported meanwhile is
      // handled next time. A watch that fails to start sets it again, to retry.
      serverReplaced = false;
      if (sourceWatch !== undefined) yield* Scope.close(sourceWatch, Exit.void);
      const latest = yield* Scope.fork(scope);
      sourceWatch = latest;
      yield* directories
        .watch(
          serverDirectory,
          { recursive: true },
          {
            change: changed,
            error: (error) => {
              // A replaced watch's late report is moot.
              if (sourceWatch !== latest) return;
              // Node 22 reports a server/ deleted during its rescan this way.
              if (error.reason._tag === "NotFound") {
                serverReplaced = true;
                changed();
              } else watchError(error);
            }
          }
        )
        .pipe(
          Scope.provide(latest),
          // Absent, or gone since: the root watch reports when server/ appears.
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.mapError(
            (cause) => new LocalError({ message: "Could not watch server source files.", cause })
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              serverReplaced = true;
            })
          )
        );
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
  });
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
