// @effect-diagnostics nodeBuiltinImport:off -- The repo's Vite builds the private guest entry and authored server modules.
import * as path from "node:path";
import type { ReleaseToolchain } from "@patchy/api";
import ts from "typescript";
import { LocalError } from "./CliError.js";
import { runToolchain } from "./toolchain.js";

/** The only server entrypoint is the SDK guest protocol around all discovered modules. */
export async function buildServer(
  root: string,
  modules: readonly string[],
  toolchain: typeof ReleaseToolchain.Type
) {
  const entry = "\0patchy-server-entry";
  const input = path.join(root, ".patchy-server-entry.js");
  const guest = path.join(root, "node_modules/patchy/dist/guest.js");
  const source = [
    `import { createGuest } from ${JSON.stringify(guest)};`,
    ...modules.map(
      (name, index) =>
        `import * as module${index} from ${JSON.stringify(path.join(root, "server", `${name}.ts`))};`
    ),
    `export default createGuest({${modules.map((name, index) => `${JSON.stringify(name)}: module${index}`).join(",")}});`
  ].join("\n");
  const built = await runToolchain(
    root,
    toolchain,
    {
      configFile: false,
      publicDir: false,
      logLevel: "warn",
      plugins: [
        {
          name: "patchy-server-entry",
          resolveId(id) {
            if (id === input || id === entry) return entry;
          },
          load(id) {
            if (id === entry) return source;
          }
        }
      ],
      build: {
        target: "esnext",
        write: false,
        sourcemap: false,
        minify: true,
        lib: { entry: input, formats: ["es"], fileName: "server" },
        rolldownOptions: { output: { codeSplitting: false } }
      }
    },
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
  const output = result.output;
  const chunk = output[0];
  if (output.length !== 1 || chunk?.type !== "chunk")
    throw new LocalError({
      code: "invalid_manifest",
      message: "The server build must emit one JavaScript module and no other assets."
    });
  const parsed = ts.createSourceFile(
    "server.js",
    chunk.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      throw new LocalError({
        code: "invalid_manifest",
        message: "The server build must be a closed module without imports."
      });
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { server: chunk.code, sdkImports: built.sdkImports };
}
