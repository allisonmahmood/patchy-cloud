// @effect-diagnostics nodeBuiltinImport:off -- Resolve the builder's installed Vite, never a second bundled toolchain.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { Manifest } from "@patchy/api";
import type * as Vite from "vite";
import { LocalError } from "./CliError.js";
import { validateRepoBundle } from "./repoBuild.js";
import { io } from "./devState.js";
// PROTOTYPE for #314
import {
  importCheck,
  importRefusal,
  loadVite,
  serverModules,
  writeServerEntry
} from "./serverBuild.js";

type Build = { readonly files: readonly string[]; readonly html: string } | LocalError;
const isLocalError = Schema.is(LocalError);

/** A completed Rollup generation, not a partially written index.html, is the swap boundary. */
export const watch = Effect.fn("Dev.watch")(function* (root: string, stateDir: string) {
  const builds = yield* Queue.sliding<Build>(1);
  const vite = yield* io(
    "Could not load the repo's installed Vite. Run `pnpm install`.",
    async () => {
      const require = createRequire(path.join(root, "package.json"));
      const module: typeof Vite = await import(pathToFileURL(require.resolve("vite")).href);
      return module;
    }
  );
  yield* Effect.acquireRelease(
    io("Could not start Vite build-watch. Check vite.config.ts.", async () => {
      const watcher = await vite.build({
        root,
        clearScreen: false,
        build: { watch: {}, outDir: path.join(stateDir, "build"), emptyOutDir: true },
        plugins: [
          // PROTOTYPE for #314: the same import check as publish, on the watched client graph.
          importCheck(root, "client"),
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
      if (!("on" in watcher)) throw new Error("Vite did not start a build watcher.");
      watcher.on("event", (event) => {
        if (event.code === "ERROR")
          Queue.offerUnsafe(
            builds,
            new LocalError({
              message:
                importRefusal(event.error) ??
                "Vite build failed. Fix the source or vite.config.ts; the last successful bundle stays served.",
              cause: event.error
            })
          );
      });
      return watcher;
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
    next.pipe(Effect.tap((html) => validateRepoBundle(root, manifest, html)));
});

// PROTOTYPE for #314: the server bundle in build-watch, same library build as publish. Each
// completed generation is one ESM module; the caller inspects and binds it. A build error keeps
// the last bound bundle serving and is printed to the dev log.
export const watchServer = Effect.fn("Dev.watchServer")(function* (root: string, stateDir: string) {
  // An object, never a bare string: a string is iterable, so `yield* result` would type-check
  // as character iteration when narrowing fails, and the generator's types collapse to `any`.
  const builds = yield* Queue.sliding<{ readonly bundle: string } | LocalError>(1);
  const vite = yield* loadVite(root);
  const modules = yield* serverModules(root);
  if (modules.length === 0)
    return yield* new LocalError({
      message: "A tier 2 repo needs at least one server/<module>.ts exporting a handler."
    });
  const entry = yield* writeServerEntry(root, modules);
  yield* Effect.acquireRelease(
    io("Could not start the server bundle watch. Check server/.", async () => {
      const watcher = await vite.build({
        root,
        configFile: false,
        logLevel: "silent",
        clearScreen: false,
        plugins: [
          importCheck(root, "server"),
          {
            name: "patchy-dev-server-bundle",
            enforce: "post",
            writeBundle(_options, bundle) {
              const output = bundle["server.js"];
              if (output?.type === "chunk") Queue.offerUnsafe(builds, { bundle: output.code });
            }
          }
        ],
        build: {
          watch: {},
          lib: { entry, formats: ["es"], fileName: () => "server.js" },
          outDir: path.join(stateDir, "server-build"),
          emptyOutDir: true,
          minify: false,
          sourcemap: false,
          target: "es2022",
          rolldownOptions: { output: { codeSplitting: false } }
        }
      });
      if (!("on" in watcher)) throw new Error("Vite did not start a server build watcher.");
      watcher.on("event", (event) => {
        if (event.code === "ERROR")
          Queue.offerUnsafe(
            builds,
            new LocalError({
              message:
                importRefusal(event.error) ??
                "Server bundle build failed. Fix server/; the last bound bundle stays served.",
              cause: event.error
            })
          );
      });
      return watcher;
    }),
    (watcher) => Effect.promise(() => watcher.close())
  );
  return Effect.gen(function* () {
    const result = yield* Queue.take(builds);
    if (isLocalError(result)) return yield* result;
    return result.bundle;
  });
});
