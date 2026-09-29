// @effect-diagnostics nodeBuiltinImport:off -- Vite build-watch consumes Node filesystem paths.
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { Manifest, ReleaseToolchain } from "@patchy/api";
import { LocalError } from "./CliError.js";
import { validateRepoBundle } from "./repoBuild.js";
import { runToolchain } from "./toolchain.js";

type Build = { readonly files: readonly string[]; readonly html: string } | LocalError;
const isLocalError = Schema.is(LocalError);

/** A completed Rollup generation, not a partially written index.html, is the swap boundary. */
export const watch = Effect.fn("Dev.watch")(function* (
  root: string,
  stateDir: string,
  toolchain: typeof ReleaseToolchain.Type,
  destination: "dev" | "local-server"
) {
  const builds = yield* Queue.sliding<Build>(1);
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const loaded = await runToolchain(root, toolchain, {
          clearScreen: false,
          build: {
            watch: {},
            outDir: path.join(stateDir, "build"),
            emptyOutDir: true
          },
          plugins: [
            {
              name: "patchy-dev-completed-bundle",
              enforce: "post",
              writeBundle(_options, bundle) {
                const output = bundle["index.html"];
                const html =
                  output?.type === "asset"
                    ? typeof output.source === "string"
                      ? output.source
                      : new TextDecoder().decode(output.source)
                    : "";
                Queue.offerUnsafe(builds, { files: Object.keys(bundle), html });
              }
            }
          ]
        });
        const watcher = loaded.result;
        if (!watcher || !("on" in watcher)) throw new Error("Vite did not start a build watcher.");
        watcher.on("event", (event) => {
          if (event.code === "ERROR")
            Queue.offerUnsafe(
              builds,
              loaded.importRefusal?.() ??
                new LocalError({
                  message:
                    "Vite build failed. Fix the source or vite.config.ts; the last successful bundle stays served.",
                  cause: event.error
                })
            );
        });
        return watcher;
      },
      catch: (cause) =>
        isLocalError(cause)
          ? cause
          : new LocalError({
              message: "Could not start Vite build-watch. Check vite.config.ts.",
              cause
            })
    }),
    (watcher) => Effect.promise(() => watcher.close())
  );
  const fs = yield* FileSystem.FileSystem;
  const next = Effect.gen(function* () {
    const result = yield* Queue.take(builds);
    if (isLocalError(result)) return yield* result;
    // public/ is copied outside Rollup's output map, so inspect the completed directory too.
    const entries = yield* fs
      .readDirectory(path.join(stateDir, "build"), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new LocalError({ message: "Could not inspect the watched build.", cause })
        )
      );
    const files: string[] = [];
    for (const entry of entries) {
      const stat = yield* fs
        .stat(path.join(stateDir, "build", entry))
        .pipe(
          Effect.mapError(
            (cause) => new LocalError({ message: "Could not inspect the watched build.", cause })
          )
        );
      if (stat.type !== "Directory") files.push(entry);
    }
    if (
      result.files.length !== 1 ||
      result.files[0] !== "index.html" ||
      files.length !== 1 ||
      files[0] !== "index.html"
    )
      return yield* new LocalError({
        message: `Vite must emit only index.html; found ${files.join(", ") || "no HTML output"}. Inline every asset with vite-plugin-singlefile; remove public files, sourcemaps and extra entrypoints.`
      });
    return result.html;
  });
  return (manifest: typeof Manifest.Type) =>
    next.pipe(Effect.tap((html) => validateRepoBundle(root, manifest, html, destination)));
});
