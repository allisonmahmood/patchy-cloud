// @effect-diagnostics nodeBuiltinImport:off -- The repo's Vite builds the private guest entry and authored server modules.
import * as path from "node:path";
import type { ReleaseToolchain } from "@patchy/api";
import type { ESTree, InlineConfig } from "vite";
import { LocalError } from "./CliError.js";
import { runToolchain } from "./toolchain.js";

/**
 * The declared aliases the guest builds its own clients for, by kind: a shared store's and a
 * Pidgeon connection's differ from a shared table's and a Postgres connection's.
 */
export interface GuestAliases {
  readonly sharedStores: readonly string[];
  readonly pidgeon: readonly string[];
}
export const guestAliases = (
  uses: Readonly<Record<string, { readonly kind: string }>>
): GuestAliases => {
  const of = (kind: string) =>
    Object.entries(uses)
      .filter(([, declaration]) => declaration.kind === kind)
      .map(([alias]) => alias);
  return { sharedStores: of("sharedStore"), pidgeon: of("pidgeon") };
};

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

/** The names a module's own export statements declare, without following `export *`. */
const ownExports = (program: ESTree.Program): ReadonlySet<string> => {
  const names = new Set<string>();
  const bind = (pattern: ESTree.BindingPattern | ESTree.BindingRestElement): void => {
    switch (pattern.type) {
      case "Identifier":
        names.add(pattern.name);
        return;
      case "ObjectPattern":
        for (const property of pattern.properties)
          bind(property.type === "RestElement" ? property : property.value);
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) if (element !== null) bind(element);
        return;
      case "AssignmentPattern":
        bind(pattern.left);
        return;
      case "RestElement":
        bind(pattern.argument);
    }
  };
  const exported = (name: ESTree.ModuleExportName) =>
    name.type === "Literal" ? name.value : name.name;
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") names.add("default");
    else if (statement.type === "ExportAllDeclaration") {
      if (statement.exported !== null) names.add(exported(statement.exported));
    } else if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      if (declaration?.type === "VariableDeclaration")
        for (const declarator of declaration.declarations) bind(declarator.id);
      else if (
        (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
        declaration.id !== null
      )
        names.add(declaration.id.name);
      for (const specifier of statement.specifiers) names.add(exported(specifier.exported));
    }
  }
  return names;
};

/** Each build's agent area: its files by stem, and each tool's file as its last build found. */
interface AgentArea {
  readonly files: readonly string[];
  tools: Readonly<Record<string, string>>;
}

/** Publish and dev share their private entry, import checks and closed-module check. */
const buildConfig = (
  root: string,
  modules: readonly string[],
  agent: AgentArea,
  aliases: GuestAliases,
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
    `export default createGuest({${modules.map((name, index) => `[${JSON.stringify(name)}]: module${index}`).join(",")}},${JSON.stringify(aliases.sharedStores)},{${agent.files.map((name, index) => `[${JSON.stringify(name)}]: agent${index}`).join(",")}},${JSON.stringify(aliases.pidgeon)});`
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
        },
        // Which file each tool comes from, for refusals that name it. Only what a file's own export
        // statements declare counts, which is always in its namespace; a tool a file gets only
        // through `export *` names no file. The guest refuses a name two files export.
        buildEnd(error) {
          if (error !== undefined) return;
          const owners = new Map<string, string>();
          for (const [index, file] of agentPaths.entries()) {
            const code = this.getModuleInfo(file)?.code;
            if (code === null || code === undefined) continue;
            for (const name of ownExports(this.parse(code)))
              if (!owners.has(name)) owners.set(name, agent.files[index]!);
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
  aliases: GuestAliases
) {
  const agent: AgentArea = { files: agentFiles, tools: {} };
  const built = await runToolchain(
    root,
    toolchain,
    buildConfig(root, modules, agent, aliases),
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
  aliases: GuestAliases,
  complete: (result: BuiltServer | LocalError) => void
) {
  let server: string | undefined;
  const agent: AgentArea = { files: agentFiles, tools: {} };
  const loaded = await runToolchain(
    root,
    toolchain,
    buildConfig(root, modules, agent, aliases, {
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
        loaded.importRefusal?.() ??
          new LocalError({
            message: "Server build failed; the last successful binding stays served.",
            cause: event.error
          })
      );
  });
  return watcher;
}
