// @effect-diagnostics nodeBuiltinImport:off -- FileSystem.watch drops unnamed events and dies if the directory vanishes as its watch starts.
/**
 * Native watches of one directory's own entries, behind a seam so tests can
 * script their events. Never recursive: Node 22's recursive watch on Linux
 * rescans in JavaScript, reporting a directory deleted mid-scan as an error
 * and swallowing other failures to start.
 */
import { watch } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** The directory is absent as the watch starts, or was deleted under it. */
export class DirectoryGone extends Schema.TaggedError<DirectoryGone>()("DirectoryGone", {
  directory: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `${this.directory} is gone.`;
  }
}

/** The watch could not start, or stopped, for any other reason. */
export class WatchFailed extends Schema.TaggedError<WatchFailed>()("WatchFailed", {
  directory: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Could not watch ${this.directory}.`;
  }
}

const failure = (directory: string, cause: unknown) =>
  Predicate.hasProperty(cause, "code") && cause.code === "ENOENT"
    ? new DirectoryGone({ directory, cause })
    : new WatchFailed({ directory, cause });

export class DirectoryWatch extends Context.Service<
  DirectoryWatch,
  {
    /** Report changes, by filename where the platform names one, until the scope closes. */
    readonly watch: (
      directory: string,
      listener: {
        readonly change: (filename: string | null) => void;
        readonly error: (error: DirectoryGone | WatchFailed) => void;
      }
    ) => Effect.Effect<void, DirectoryGone | WatchFailed, Scope.Scope>;
  }
>()("patchy/DirectoryWatch") {}

export const layer = Layer.succeed(DirectoryWatch, {
  watch: (directory, listener) =>
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          watch(directory, (_event, filename) => listener.change(filename)).on("error", (cause) =>
            listener.error(failure(directory, cause))
          ),
        catch: (cause) => failure(directory, cause)
      }),
      (watcher) => Effect.sync(() => watcher.close())
    ).pipe(Effect.asVoid)
});
