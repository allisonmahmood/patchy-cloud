// @effect-diagnostics nodeBuiltinImport:off -- TypeScript reports tsconfig files as resolved paths.
import * as path from "node:path";
import {
  HandlerModuleName,
  descriptionProblem,
  descriptionRefusal,
  type HandlerDescriptors
} from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import ts from "typescript";
import { LocalError } from "./CliError.js";
import { serverAgentModule } from "./handlerDescriptors.js";
import { safePath } from "./ManagedProject.js";

const isModuleName = Schema.is(HandlerModuleName);
const sourcePath = (root: string, relative: string) =>
  Effect.tryPromise({
    try: () => safePath(root, relative),
    catch: (cause) =>
      new LocalError({
        message: `Could not inspect ${relative}; server sources must not be symbolic links.`,
        code: "invalid_manifest",
        cause
      })
  });

/** Each source folder's files sit one level deep and are named like module.export modules. */
const discoverSources = Effect.fn("discoverSources")(function* (
  root: string,
  folder: "server" | "agent"
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* sourcePath(root, folder);
  const what = folder === "server" ? "Server modules" : "Agent tool files";
  // A missing folder or entry holds no module, including one deleted while this reads.
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const modules: string[] = [];
  for (const entry of entries) {
    const relative = `${folder}/${entry}`;
    const target = yield* sourcePath(root, relative);
    const info = yield* fs
      .stat(target)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
    if (info === undefined) continue;
    if (info.type === "Directory")
      return yield* new LocalError({
        message: `${what} must be one level deep; move ${relative}/*.ts into ${folder}/.`,
        code: "invalid_manifest"
      });
    if (!entry.endsWith(".ts")) continue;
    const module = entry.slice(0, -3);
    if (info.type !== "File" || !isModuleName(module))
      return yield* new LocalError({
        message: `Invalid ${folder} filename: ${relative}. Start with a letter, then use letters, digits, _, $ or -.`,
        code: "invalid_manifest"
      });
    modules.push(module);
  }
  return modules.sort();
});

/** Enumerate source names only: generation must work before server code can compile. */
export const discoverServerModules = Effect.fn("discoverServerModules")(
  function* (root: string) {
    const modules = yield* discoverSources(root, "server");
    // The agent area folds into the module named agent, so server/agent.ts would clash.
    if (modules.includes("agent"))
      return yield* new LocalError({ message: serverAgentModule, code: "invalid_manifest" });
    return modules;
  },
  Effect.catchTags({
    PlatformError: (cause) =>
      Effect.fail(new LocalError({ message: "Could not inspect server/ source filenames.", cause }))
  })
);

/**
 * The agent area's files by filename stem. Nothing generated lists them, so the dev watcher and
 * publish discover them on every build and adding one needs no refresh.
 */
export const discoverAgentFiles = Effect.fn("discoverAgentFiles")(
  (root: string) => discoverSources(root, "agent"),
  Effect.catchTags({
    PlatformError: (cause) =>
      Effect.fail(new LocalError({ message: "Could not inspect agent/ source filenames.", cause }))
  })
);

/**
 * The warning for a `tsconfig.json` whose files leave out an agent file. Nothing imports `agent/`,
 * so `tsc` checks it only through `include`; an older repo's list predates the folder.
 */
export const agentTypecheckWarning = (root: string, files: readonly string[]) => {
  if (files.length === 0) return undefined;
  const configPath = path.resolve(root, "tsconfig.json");
  // Without a readable tsconfig.json, publish's own typecheck reports the problem.
  if (!ts.sys.fileExists(configPath)) return undefined;
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error !== undefined) return undefined;
  const checked = new Set(
    ts
      .parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath), undefined, configPath)
      .fileNames.map((file) => path.resolve(file))
  );
  return files.every((file) => checked.has(path.resolve(root, "agent", `${file}.ts`)))
    ? undefined
    : 'tsconfig.json doesn\'t include agent/, so pnpm typecheck skips your agent tools. Add "agent" to its include list.';
};

/** Refresh owns the generated module list; publish must not silently repair it. */
export const validateGeneratedServerModules = Effect.fn("validateGeneratedServerModules")(
  function* (root: string, modules: readonly string[]) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* sourcePath(root, "patchy/_generated/server.ts");
    const contents = yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (cause) =>
          new LocalError({
            code: "stale_generated",
            message: "The generated server module list is missing; run `patchy refresh`.",
            cause
          })
      )
    );
    const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
    const generated: string[] = [];
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.isTypeOnly &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const match = /^\.\.\/\.\.\/server\/([^/]+)\.js$/.exec(statement.moduleSpecifier.text);
        if (match !== null) generated.push(match[1]!);
      }
    }
    generated.sort();
    if (
      generated.length !== modules.length ||
      generated.some((name, index) => name !== modules[index])
    )
      return yield* new LocalError({
        code: "stale_generated",
        message: "The server module list changed; run `patchy refresh`."
      });
  }
);

/**
 * The build's refusal for the first bad description in its handlers, naming the handler's file.
 * An agent tool's file is the one the build found exporting it; a re-exported server handler is
 * checked under its server name first, so its refusal names the file that defines it.
 */
export const descriptionFailure = (
  handlers: HandlerDescriptors,
  agentTools: Readonly<Record<string, string>>
): string | undefined => {
  const problem = descriptionProblem(handlers);
  if (problem === undefined) return undefined;
  const dot = problem.handler.indexOf(".");
  const module = problem.handler.slice(0, dot);
  const file =
    module === "agent"
      ? `agent/${agentTools[problem.handler.slice(dot + 1)] ?? "*"}.ts`
      : `server/${module}.ts`;
  return `${file}: ${descriptionRefusal(problem)}`;
};
