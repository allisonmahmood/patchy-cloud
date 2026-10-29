// @effect-diagnostics nodeBuiltinImport:off -- TypeScript reports tsconfig files as paths for the repo's own Node.
import * as path from "node:path";
import { parse } from "@babel/parser";
import {
  HandlerModuleName,
  agentAreaRefusal,
  checkAgentArea,
  descriptionProblem,
  descriptionRefusal,
  type HandlerDescriptors,
  type Manifest
} from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";
import { serverAgentModule } from "./handlerDescriptors.js";
import { safePath } from "./ManagedProject.js";
import { processResult } from "./processResult.js";

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

const decodeShownConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) }))
);

/**
 * The warning for a `tsconfig.json` whose files leave out an agent file. Nothing imports `agent/`,
 * so `tsc` checks it only through `include`; an older repo's list predates the folder. The repo's
 * own compiler lists the files (`tsc --showConfig`), so `include`, `exclude` and `extends` mean
 * what they mean to `pnpm typecheck`.
 */
export const agentTypecheckWarning = Effect.fn("agentTypecheckWarning")(function* (
  root: string,
  files: readonly string[]
) {
  if (files.length === 0) return undefined;
  const shown = yield* processResult(root, process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--showConfig",
    "-p",
    "tsconfig.json"
  ]).pipe(Effect.option);
  // TypeScript 6 refuses a config that matches no files (TS18003); 7 prints it without `files`.
  const config = Option.flatMap(shown, (result) =>
    result.stdout.includes("error TS18003")
      ? Option.some({ files: [] })
      : decodeShownConfig(result.stdout)
  );
  // Without a compiler or a readable tsconfig.json, publish's own typecheck reports the problem.
  if (Option.isNone(config)) return undefined;
  const checked = new Set((config.value.files ?? []).map((file) => path.resolve(root, file)));
  return files.every((file) => checked.has(path.resolve(root, "agent", `${file}.ts`)))
    ? undefined
    : 'tsconfig.json doesn\'t include agent/, so pnpm typecheck skips your agent tools. Add "agent" to its include list.';
});

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
    const { program } = yield* Effect.try({
      try: () => parse(contents, { sourceType: "module", plugins: ["typescript"] }),
      catch: (cause) =>
        new LocalError({
          code: "stale_generated",
          message: "The generated server module list is unreadable; run `patchy refresh`.",
          cause
        })
    });
    const generated: string[] = [];
    for (const statement of program.body) {
      if (statement.type === "ImportDeclaration" && statement.importKind === "type") {
        const match = /^\.\.\/\.\.\/server\/([^/]+)\.js$/.exec(statement.source.value);
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

/** The file under `agent/` the build found exporting a tool. */
const agentFile = (agentTools: Readonly<Record<string, string>>, tool: string) =>
  `agent/${Object.hasOwn(agentTools, tool) ? agentTools[tool] : "*"}.ts`;

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
  const tool = problem.handler.slice(dot + 1);
  // A tool the build found no file for, such as one only an `export *` gives, names none.
  const file = module === "agent" ? agentFile(agentTools, tool) : `server/${module}.ts`;
  return `${file}: ${descriptionRefusal(problem)}`;
};

/**
 * The build's refusal from the agent area check the instance also runs, naming the tool's file.
 * Its argument warnings come back from publish.
 */
export const agentAreaFailure = (
  manifest: Pick<typeof Manifest.Type, "tables" | "handlers">,
  agentTools: Readonly<Record<string, string>>
): string | undefined => {
  const { problem } = checkAgentArea(manifest);
  if (problem === undefined) return undefined;
  const refusal = agentAreaRefusal(problem);
  // The size belongs to the whole folder, and server/agent.ts is refused before any build.
  return problem._tag === "TooLarge" || problem._tag === "ServerAgentModule"
    ? refusal
    : `${agentFile(agentTools, problem.tool)}: ${refusal}`;
};
