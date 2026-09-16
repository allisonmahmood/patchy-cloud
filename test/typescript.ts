import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const compilers = {
  native: fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  legacy: fileURLToPath(
    new URL("./fixtures/typescript6/node_modules/typescript/bin/tsc", import.meta.url)
  )
};

/** Compile actual consumer files, including their @ts-expect-error assertions. */
export const compileConsumer = Effect.fn("compileConsumer")(
  function* (
    files: Readonly<Record<string, string>>,
    paths: Readonly<Record<string, readonly string[]>>,
    compiler: keyof typeof compilers = "native"
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "patchy typecheck " });
    for (const [name, source] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(cwd, name), source);
    }
    yield* fs.writeFileString(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          types: [],
          paths,
          resolveJsonModule: true,
          skipLibCheck: true
        },
        files: Object.keys(files)
      })
    );
    const child = yield* ChildProcess.make(
      process.execPath,
      [compilers[compiler], "-p", "tsconfig.json"],
      {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      }
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
        child.exitCode
      ],
      { concurrency: "unbounded" }
    );
    return { stdout, stderr, code };
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);
