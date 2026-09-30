// @effect-diagnostics nodeBuiltinImport:off -- The repo's Vite builds the private guest entry and authored server modules.
import * as path from "node:path";
import type { ReleaseToolchain } from "@patchy/api";
import type { InlineConfig } from "vite";
import { LocalError } from "./CliError.js";
import { runToolchain } from "./toolchain.js";

export interface BuiltServer {
  readonly server: string;
  readonly sdkImports: readonly string[];
}

interface ServerOutput {
  readonly type: "asset" | "chunk";
  readonly code?: string;
}

const serverCode = (output: readonly ServerOutput[]) => {
  const chunk = output[0];
  if (output.length !== 1 || chunk?.type !== "chunk" || chunk.code === undefined)
    throw new LocalError({
      code: "invalid_manifest",
      message: "The server build must emit one JavaScript module and no other assets."
    });
  return chunk.code;
};

/** Publish and dev share their private entry, import checks and closed-module check. */
const buildConfig = (
  root: string,
  modules: readonly string[],
  sharedStores: readonly string[],
  watched?: { readonly outDir: string; readonly complete: (server: string) => void }
): InlineConfig => {
  const entry = "\0patchy-server-entry";
  const input = path.join(root, ".patchy-server-entry.js");
  // Reuse the handler SDK's guest export instead of bundling its schemas a second time.
  const guest = path.join(root, "node_modules/patchy/dist/server.js");
  const source = [
    `import { createGuest } from ${JSON.stringify(guest)};`,
    ...modules.map(
      (name, index) =>
        `import * as module${index} from ${JSON.stringify(path.join(root, "server", `${name}.ts`))};`
    ),
    `export default createGuest({${modules.map((name, index) => `${JSON.stringify(name)}: module${index}`).join(",")}},${JSON.stringify(sharedStores)});`
  ].join("\n");
  return {
    configFile: false,
    publicDir: false,
    logLevel: watched === undefined ? "warn" : "silent",
    plugins: [
      {
        name: "patchy-server-entry",
        resolveId(id) {
          if (id === input || id === entry) return entry;
        },
        load(id) {
          if (id === entry) return source;
        },
        generateBundle(_options, bundle) {
          if (watched !== undefined) watched.complete(serverCode(Object.values(bundle)));
        }
      }
    ],
    build: {
      target: "esnext",
      write: watched !== undefined,
      sourcemap: false,
      minify: watched === undefined,
      lib: { entry: input, formats: ["es"], fileName: "server" },
      rolldownOptions: {
        output: { codeSplitting: false },
        ...(watched === undefined ? {} : { experimental: { incrementalBuild: true } })
      },
      ...(watched === undefined
        ? {}
        : { watch: { buildDelay: 0 }, outDir: watched.outDir, emptyOutDir: true })
    }
  };
};

export async function buildServer(
  root: string,
  modules: readonly string[],
  toolchain: typeof ReleaseToolchain.Type,
  sharedStores: readonly string[]
) {
  const built = await runToolchain(
    root,
    toolchain,
    buildConfig(root, modules, sharedStores),
    "server"
  );
  const result = Array.isArray(built.result)
    ? built.result.length === 1
      ? built.result[0]
      : undefined
    : built.result;
  if (result === undefined || !("output" in result))
    throw new LocalError({
      code: "invalid_manifest",
      message: "The server build did not produce a closed module."
    });
  return { server: serverCode(result.output), sdkImports: built.sdkImports };
}

/** Keep Vite's dependency graph and transformed modules between ordinary handler saves. */
export async function watchServer(
  root: string,
  modules: readonly string[],
  toolchain: typeof ReleaseToolchain.Type,
  outDir: string,
  sharedStores: readonly string[],
  complete: (result: BuiltServer | LocalError) => void
) {
  let server: string | undefined;
  const loaded = await runToolchain(
    root,
    toolchain,
    buildConfig(root, modules, sharedStores, {
      outDir,
      complete: (built) => {
        server = built;
      }
    }),
    "server"
  );
  const watcher = loaded.result;
  if (watcher === undefined || !("on" in watcher))
    throw new LocalError({ message: "Vite did not start a server build watcher." });
  watcher.on("event", (event) => {
    if (event.code === "BUNDLE_START") server = undefined;
    else if (event.code === "BUNDLE_END" && server !== undefined)
      complete({ server, sdkImports: loaded.sdkImports });
    else if (event.code === "ERROR")
      complete(
        loaded.importRefusal?.() ??
          new LocalError({
            message: "Server build failed; the last successful binding stays served.",
            cause: event.error
          })
      );
  });
  return watcher;
}
