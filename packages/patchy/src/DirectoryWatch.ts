// @effect-diagnostics nodeBuiltinImport:off -- FileSystem.watch drops unnamed events and dies if the directory vanishes as its watch starts.
/**
 * Native directory watches, behind a seam so tests can script their events.
 * Failures read like FileSystem's: a `PlatformError` whose `NotFound` reason
 * means the directory is gone, whether at the start or while watching.
 */
import { watch } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";

const failure = (directory: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: Predicate.hasProperty(cause, "code") && cause.code === "ENOENT" ? "NotFound" : "Unknown",
    module: "DirectoryWatch",
    method: "watch",
    pathOrDescriptor: directory,
    cause
  });

export class DirectoryWatch extends Context.Service<
  DirectoryWatch,
  {
    /** Report changes, by filename where the platform names one, until the scope closes. */
    readonly watch: (
      directory: string,
      options: { readonly recursive: boolean },
      listener: {
        readonly change: (filename: string | null) => void;
        readonly error: (error: PlatformError.PlatformError) => void;
      }
    ) => Effect.Effect<void, PlatformError.PlatformError, Scope.Scope>;
  }
>()("patchy/DirectoryWatch") {}

export const layer = Layer.succeed(DirectoryWatch, {
  watch: (directory, { recursive }, listener) =>
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          watch(directory, { recursive }, (_event, filename) => listener.change(filename)).on(
            "error",
            (cause) => listener.error(failure(directory, cause))
          ),
        catch: (cause) => failure(directory, cause)
      }),
      (watcher) => Effect.sync(() => watcher.close())
    ).pipe(Effect.asVoid)
});
