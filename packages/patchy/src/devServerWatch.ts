import type { HandlerDescriptors, Manifest, ReleaseToolchain } from "@patchy/api";
import * as Inspection from "@patchy/execution/inspection";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { LocalError } from "./CliError.js";
import * as DirectoryWatch from "./DirectoryWatch.js";
import { watchServer, type BuiltServer, type GuestAliases } from "./serverBuild.js";
import {
  agentAreaFailure,
  agentTypecheckWarning,
  descriptionFailure,
  discoverAgentFiles,
  discoverServerModules
} from "./serverModules.js";

export interface ServerBuild extends BuiltServer {
  readonly modules: readonly string[];
  readonly agentFiles: readonly string[];
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
type SourceFolder = "server" | "agent";

/** Consume builds serially; inspect and stage may run together, but installation awaits both. */
export const watch = Effect.fn("Dev.watchServer")(function* (
  root: string,
  toolchain: typeof ReleaseToolchain.Type,
  aliases: GuestAliases,
  /** The running manifest's tables, which the agent area check resolves rows against. */
  tables: (typeof Manifest.Type)["tables"]
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
  // The repo pins workerd, so a CLI installed without one still inspects its server.
  const inspection = yield* Inspection.make({ workerdFrom: root }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          code: "invalid_manifest",
          message: "Could not start server inspection.",
          cause
        })
    )
  );
  // Each source folder's own watch, restarted when the folder itself is replaced.
  const folders: Record<SourceFolder, { replaced: boolean; watch: Scope.Closeable | undefined }> = {
    server: { replaced: true, watch: undefined },
    agent: { replaced: true, watch: undefined }
  };
  let builder: { close(): Promise<void> } | undefined;
  // The last discovery, absent until the first, which reminds about no module.
  let sources:
    { readonly modules: readonly string[]; readonly agentFiles: readonly string[] } | undefined;
  let generation = 0;
  let sourcesPending = false;
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
  yield* Effect.addFinalizer(() => Effect.promise(async () => await builder?.close()));
  // Directory watches see modules and agent files come and go; Vite watches what they
  // import. Both folders are one level deep, so no watch recurses.
  yield* directories
    .watch(root, {
      change: (filename) => {
        if (filename === null) {
          folders.server.replaced = true;
          folders.agent.replaced = true;
          changed();
        } else if (filename === "server" || filename === "agent") {
          folders[filename].replaced = true;
          changed();
        }
      },
      error: watchError
    })
    .pipe(
      Effect.mapError(
        (cause) => new LocalError({ message: "Could not watch server source files.", cause })
      )
    );
  const rewatch = Effect.fn("Dev.watchServer.folder")(function* (name: SourceFolder) {
    const folder = folders[name];
    if (!folder.replaced) return;
    // Clear the flag before any work, so a replacement reported meanwhile is handled
    // next time. A failure to start, other than a missing folder, sets it again to retry.
    folder.replaced = false;
    if (folder.watch !== undefined) yield* Scope.close(folder.watch, Exit.void);
    const latest = yield* Scope.fork(scope);
    folder.watch = latest;
    yield* directories
      .watch(path.join(root, name), {
        change: changed,
        error: (error) => {
          // A replaced watch's late report is moot.
          if (folder.watch !== latest) return;
          if (error._tag === "DirectoryGone") {
            folder.replaced = true;
            changed();
          } else watchError(error);
        }
      })
      .pipe(
        Scope.provide(latest),
        // Absent, or deleted since: the root watch reports when the folder appears.
        Effect.catchTags({ DirectoryGone: () => Effect.void }),
        Effect.mapError(
          (cause) => new LocalError({ message: "Could not watch server source files.", cause })
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            folder.replaced = true;
          })
        )
      );
  });
  const same = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((name, index) => name === right[index]);
  const rediscover = Effect.fn("Dev.watchServer.sources")(function* () {
    yield* rewatch("server");
    yield* rewatch("agent");
    const modules = yield* discoverServerModules(root);
    const agentFiles = yield* discoverAgentFiles(root);
    if (
      builder !== undefined &&
      sources !== undefined &&
      same(sources.modules, modules) &&
      same(sources.agentFiles, agentFiles)
    )
      return false;
    if (sources !== undefined) {
      for (const name of modules) {
        if (!sources.modules.includes(name))
          yield* Console.log(`new server module ${name}: run pnpm patchy refresh for types`);
      }
    }
    if (!same(sources?.agentFiles ?? [], agentFiles)) {
      const skipped = agentTypecheckWarning(root, agentFiles);
      if (skipped !== undefined) yield* Console.log(skipped);
    }
    const previous = builder;
    builder = undefined;
    const current = ++generation;
    if (previous !== undefined) yield* Effect.promise(() => previous.close());
    sources = { modules, agentFiles };
    builder = yield* Effect.tryPromise({
      try: () =>
        watchServer(root, modules, agentFiles, toolchain, output, aliases, (result) => {
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
        ...sources!,
        inspect: inspection.inspect(built.server).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                code: "invalid_manifest",
                message:
                  cause.problem === undefined
                    ? "Could not inspect the server bundle. Its modules must load and export only valid handlers; the last successful binding stays served."
                    : `${cause.problem} The last successful binding stays served.`,
                cause
              })
          ),
          Effect.flatMap((handlers) => {
            const problem =
              descriptionFailure(handlers, built.agentTools) ??
              agentAreaFailure({ tables, handlers }, built.agentTools);
            return problem === undefined
              ? Effect.succeed(handlers)
              : Effect.fail(
                  new LocalError({
                    code: "invalid_manifest",
                    message: `${problem} The last successful binding stays served.`
                  })
                );
          })
        )
      };
    }
  });
});
