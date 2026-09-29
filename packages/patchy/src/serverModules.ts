import { HandlerModuleName } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import ts from "typescript";
import { LocalError } from "./CliError.js";
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

/** Enumerate source names only: generation must work before server code can compile. */
export const discoverServerModules = Effect.fn("discoverServerModules")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* sourcePath(root, "server");
    if (!(yield* fs.exists(directory))) return [];
    const modules: string[] = [];
    for (const entry of yield* fs.readDirectory(directory)) {
      const relative = `server/${entry}`;
      const target = yield* sourcePath(root, relative);
      const info = yield* fs.stat(target);
      if (info.type === "Directory")
        return yield* new LocalError({
          message: `Server modules must be one level deep; move ${relative}/*.ts into server/.`,
          code: "invalid_manifest"
        });
      if (!entry.endsWith(".ts")) continue;
      const module = entry.slice(0, -3);
      if (info.type !== "File" || !isModuleName(module))
        return yield* new LocalError({
          message: `Invalid server module filename: ${relative}. Use a module name accepted by module.export handler names.`,
          code: "invalid_manifest"
        });
      modules.push(module);
    }
    return modules.sort();
  },
  Effect.catchTags({
    PlatformError: (cause) =>
      Effect.fail(new LocalError({ message: "Could not inspect server/ source filenames.", cause }))
  })
);

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
