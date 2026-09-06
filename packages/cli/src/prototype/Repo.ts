/**
 * PROTOTYPE (#176). The patch repo as the CLI sees it: where it is (the
 * nearest `patchy.config.ts` upward from the working directory), its
 * manifest (the config executed locally, never on the server), the id the
 * first publish wrote to `patchy.json`, and the files `init` and `refresh`
 * write.
 *
 * The config is TypeScript that imports `@patchy/sdk`, so it is bundled with
 * esbuild to one module under `.patchy/` and imported from there. The
 * server only ever receives the manifest that produces.
 */
// @effect-diagnostics nodeBuiltinImport:off -- importing the bundled config is a dynamic ESM import; esbuild is Node's.
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Manifest } from "@patchy/api";
import { LocalError } from "../CliError.js";
import * as Tree from "./Tree.js";

export const CONFIG_FILE = "patchy.config.ts";
export const ID_FILE = "patchy.json";
/** Local dev data and build scratch; gitignored by the tree `init` lays down. */
export const LOCAL_DIR = ".patchy";

const PatchJson = Schema.Struct({ patchId: Schema.NullOr(Schema.String) });
const decodePatchJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PatchJson));
const decodeManifest = Schema.decodeUnknownEffect(Manifest);

/** The repo root: the nearest directory upward holding `patchy.config.ts`. */
export const find = Effect.fn("Repo.find")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = path.resolve(cwd);
  for (;;) {
    if (yield* fs.exists(path.join(dir, CONFIG_FILE)).pipe(Effect.orElseSucceed(() => false))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return yield* new LocalError({
        message: `No ${CONFIG_FILE} found in ${path.resolve(cwd)} or above. Run patchy init --tier 1 <dir> to start a patch.`
      });
    }
    dir = parent;
  }
});

/** The id the first publish wrote, or none. */
export const readPatchId = Effect.fn("Repo.readPatchId")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, ID_FILE);
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return Option.none();
  const parsed = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodePatchJson),
    Effect.mapError((cause) => new LocalError({ message: `Could not read ${file}.`, cause }))
  );
  return Option.fromNullishOr(parsed.patchId);
});

export const writePatchId = Effect.fn("Repo.writePatchId")(function* (
  root: string,
  patchId: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .writeFileString(path.join(root, ID_FILE), Tree.patchJson(patchId))
    .pipe(
      Effect.mapError((cause) => new LocalError({ message: `Could not write ${ID_FILE}.`, cause }))
    );
});

/**
 * Executes `patchy.config.ts` and answers its manifest. Bundled first so the
 * SDK import resolves from the repo's own `node_modules`, whatever the CLI
 * was installed from.
 */
export const manifest = Effect.fn("Repo.manifest")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outfile = path.join(root, LOCAL_DIR, "config.mjs");
  yield* fs.makeDirectory(path.dirname(outfile), { recursive: true }).pipe(Effect.orDie);
  yield* Effect.tryPromise({
    try: () =>
      esbuild.build({
        entryPoints: [path.join(root, CONFIG_FILE)],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        logLevel: "silent"
      }),
    catch: (cause) =>
      new LocalError({
        message: `${CONFIG_FILE} did not compile:\n${cause instanceof Error ? cause.message : String(cause)}`,
        cause
      })
  });
  const stamp = yield* Clock.currentTimeMillis;
  const loaded = yield* Effect.tryPromise({
    // A cache-busting query so a changed config is re-executed in one process.
    try: () => import(`${pathToFileURL(outfile).href}?t=${stamp}`) as Promise<unknown>,
    catch: (cause) =>
      new LocalError({
        message: `${CONFIG_FILE} threw while executing:\n${cause instanceof Error ? cause.message : String(cause)}`,
        cause
      })
  });
  const sdk = yield* Effect.tryPromise({
    try: () => import("@patchy/sdk"),
    catch: (cause) => new LocalError({ message: "The CLI could not load @patchy/sdk.", cause })
  });
  const config =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  if (typeof config !== "object" || config === null || !("tier" in config)) {
    return yield* new LocalError({
      message: `${CONFIG_FILE} must default-export defineConfig({ ... }).`
    });
  }
  const raw = yield* Effect.try({
    try: () => sdk.toManifest(config as Parameters<typeof sdk.toManifest>[0]),
    catch: (cause) =>
      new LocalError({
        message: `${CONFIG_FILE} is not a valid config:\n${cause instanceof Error ? cause.message : String(cause)}`,
        cause
      })
  });
  return yield* decodeManifest(raw).pipe(
    Effect.mapError(
      (cause) => new LocalError({ message: `${CONFIG_FILE} produced an invalid manifest.`, cause })
    )
  );
});

/** Writes every file of a fresh tree. Refuses a directory that already has a config. */
export const layDown = Effect.fn("Repo.layDown")(function* (root: string, context: Tree.Context) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(path.join(root, CONFIG_FILE)).pipe(Effect.orElseSucceed(() => false))) {
    return yield* new LocalError({ message: `${root} already holds a ${CONFIG_FILE}.` });
  }
  const write = (relative: string, content: string) =>
    fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(path.join(root, relative), content)),
      Effect.mapError((cause) => new LocalError({ message: `Could not write ${relative}.`, cause }))
    );
  yield* write(CONFIG_FILE, Tree.patchConfig(context.tier));
  yield* write(ID_FILE, Tree.patchJson(null));
  yield* write("package.json", Tree.packageJson(context.name, context.sdkSpec));
  yield* write("vite.config.ts", Tree.viteConfig);
  yield* write("tsconfig.json", Tree.tsconfig);
  yield* write("pnpm-workspace.yaml", Tree.pnpmWorkspace);
  yield* write(".gitignore", Tree.gitignore);
  yield* write("index.html", Tree.indexHtml(context.name));
  yield* write("src/main.ts", Tree.mainTs);
  yield* refresh(root, context);
});

/** Rewrites what the instance owns: the context file, the generated directory, the skill. */
export const refresh = Effect.fn("Repo.refresh")(function* (root: string, context: Tree.Context) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const write = (relative: string, content: string) =>
    fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(path.join(root, relative), content)),
      Effect.mapError((cause) => new LocalError({ message: `Could not write ${relative}.`, cause }))
    );
  yield* write("AGENTS.md", Tree.agentsMd(context));
  yield* write("CLAUDE.md", Tree.claudeMd);
  yield* write("patchy/_generated/client.ts", Tree.generatedClient);
  yield* write("patchy/_generated/context.json", Tree.generatedContext(context));
  yield* write(".agents/skills/patchy-sdk/SKILL.md", Tree.skillMd);
});
