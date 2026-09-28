import { HandlerModuleName } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
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
