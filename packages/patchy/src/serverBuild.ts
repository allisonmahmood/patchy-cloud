// @effect-diagnostics nodeBuiltinImport:off -- The repo's Vite builds the private guest entry and authored server modules.
import * as path from "node:path";
import type { ReleaseToolchain } from "@patchy/api";
import type { InlineConfig } from "vite";
import { LocalError } from "./CliError.js";
import { duplicateAgentTool } from "./handlerDescriptors.js";
import { runToolchain } from "./toolchain.js";

export interface BuiltServer {
  readonly server: string;
  readonly sdkImports: readonly string[];
  /** Each agent tool's file under `agent/`, by stem, so refusals can name it. */
  readonly agentTools: Readonly<Record<string, string>>;
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

type Certainty = "one" | "maybe";
class UnknownExports extends Error {}

/**
 * Each build's agent area: its files by stem, and what its last build found, each tool's file or
 * the refusal for a name two files export.
 */
interface AgentArea {
  readonly files: readonly string[];
  tools: Readonly<Record<string, string>>;
  refusal: LocalError | undefined;
}

/** Publish and dev share their private entry, import checks and closed-module check. */
const buildConfig = (
  root: string,
  modules: readonly string[],
  agent: AgentArea,
  sharedStores: readonly string[],
  watched?: { readonly outDir: string; readonly complete: (server: string) => void }
): InlineConfig => {
  const entry = "\0patchy-server-entry";
  const input = path.join(root, ".patchy-server-entry.js");
  // Reuse the handler SDK's guest export instead of bundling its schemas a second time.
  const guest = path.join(root, "node_modules/patchy/dist/server.js");
  const agentPaths = agent.files.map((name) => path.join(root, "agent", `${name}.ts`));
  const source = [
    `import { createGuest } from ${JSON.stringify(guest)};`,
    ...modules.map(
      (name, index) =>
        `import * as module${index} from ${JSON.stringify(path.join(root, "server", `${name}.ts`))};`
    ),
    ...agentPaths.map((file, index) => `import * as agent${index} from ${JSON.stringify(file)};`),
    // Computed keys, so a file named __proto__ is a key rather than the object's prototype.
    `export default createGuest({${modules.map((name, index) => `[${JSON.stringify(name)}]: module${index}`).join(",")}},${JSON.stringify(sharedStores)},{${agent.files.map((name, index) => `[${JSON.stringify(name)}]: agent${index}`).join(",")}});`
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
        buildStart() {
          agent.tools = {};
          agent.refusal = undefined;
        },
        // The guest refuses a name two files export too, but inside workerd, where its message is
        // lost; here the refusal can name both files.
        async buildEnd(error) {
          if (error !== undefined) return;
          // Each name a module exports: "one" when its namespace surely holds the name, "maybe"
          // when an `export *` leaves that open. Two star sources giving a name may be one
          // binding or an ambiguity, which ES modules leave out, so only "one" names count.
          const memo = new Map<string, ReadonlyMap<string, Certainty>>();
          const exported = async (
            id: string,
            visiting: Set<string>
          ): Promise<ReadonlyMap<string, Certainty>> => {
            const known = memo.get(id);
            if (known !== undefined) return known;
            const info = this.getModuleInfo(id);
            // A cycle back into a module adds nothing, as in ES module linking.
            if (info === null || visiting.has(id)) return new Map();
            const names = new Map<string, Certainty>(
              info.exports.filter((name) => name !== "*").map((name) => [name, "one"])
            );
            if (info.exports.includes("*")) {
              // `export *` is listed as "*"; follow each star source as the bundle links it.
              if (info.code === null) throw new UnknownExports();
              visiting.add(id);
              const starred = new Map<string, Certainty>();
              for (const statement of this.parse(info.code).body) {
                if (statement.type !== "ExportAllDeclaration" || statement.exported !== null)
                  continue;
                const target = await this.resolve(statement.source.value, id);
                if (target === null) continue;
                for (const [name, certainty] of await exported(target.id, visiting))
                  if (name !== "default" && !names.has(name))
                    starred.set(name, starred.has(name) ? "maybe" : certainty);
              }
              visiting.delete(id);
              for (const [name, certainty] of starred) names.set(name, certainty);
            }
            memo.set(id, names);
            return names;
          };
          const owners = new Map<string, string>();
          for (const [index, file] of agentPaths.entries()) {
            const stem = agent.files[index]!;
            const names = await exported(file, new Set()).catch((cause: unknown) => {
              // Without a module's code its star names are unknown; the guest still refuses a
              // duplicate when the bundle loads, with a plainer message.
              if (cause instanceof UnknownExports) return undefined;
              throw cause;
            });
            if (names === undefined) return;
            for (const [name, certainty] of names) {
              if (certainty !== "one") continue;
              const owner = owners.get(name);
              if (owner !== undefined) {
                agent.refusal = new LocalError({
                  code: "invalid_manifest",
                  message: duplicateAgentTool(name, owner, stem)
                });
                // Bundlers mutate thrown errors; the caller reads the refusal instead.
                throw new Error(agent.refusal.message);
              }
              owners.set(name, stem);
            }
          }
          agent.tools = Object.fromEntries(owners);
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
  agentFiles: readonly string[],
  toolchain: typeof ReleaseToolchain.Type,
  sharedStores: readonly string[]
) {
  const agent: AgentArea = { files: agentFiles, tools: {}, refusal: undefined };
  const built = await runToolchain(
    root,
    toolchain,
    buildConfig(root, modules, agent, sharedStores),
    "server"
  ).catch((cause: unknown) => {
    throw agent.refusal ?? cause;
  });
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
  return {
    server: serverCode(result.output),
    sdkImports: built.sdkImports,
    agentTools: agent.tools
  };
}

/** Keep Vite's dependency graph and transformed modules between ordinary handler saves. */
export async function watchServer(
  root: string,
  modules: readonly string[],
  agentFiles: readonly string[],
  toolchain: typeof ReleaseToolchain.Type,
  outDir: string,
  sharedStores: readonly string[],
  complete: (result: BuiltServer | LocalError) => void
) {
  let server: string | undefined;
  const agent: AgentArea = { files: agentFiles, tools: {}, refusal: undefined };
  const loaded = await runToolchain(
    root,
    toolchain,
    buildConfig(root, modules, agent, sharedStores, {
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
      complete({ server, sdkImports: loaded.sdkImports, agentTools: agent.tools });
    else if (event.code === "ERROR")
      complete(
        agent.refusal ??
          loaded.importRefusal?.() ??
          new LocalError({
            message: "Server build failed; the last successful binding stays served.",
            cause: event.error
          })
      );
  });
  return watcher;
}
