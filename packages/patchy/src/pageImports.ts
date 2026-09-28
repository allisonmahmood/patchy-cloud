// @effect-diagnostics nodeBuiltinImport:off -- Vite module ids and the installed SDK use Node paths.
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import * as CssTree from "css-tree";
import ts from "typescript";
import type { Plugin } from "vite";
import { LocalError } from "./CliError.js";

const pageEntries = [
  "patchy/preact",
  "patchy/preact/jsx-runtime",
  "patchy/preact/jsx-dev-runtime",
  "patchy/csv"
];

/** Check the actual page graph, before aliases, tree shaking, or package resolution hide imports. */
export function pageImports(
  root: string,
  refused: (error: LocalError | undefined) => void
): Plugin {
  const sdkDirectory = realpathSync(path.join(root, "node_modules/patchy"));
  const sdkDirectories = [
    sdkDirectory,
    ...["preact", "@preact/signals", "@preact/signals-core"].map((name) =>
      realpathSync(path.join(sdkDirectory, "node_modules", name))
    )
  ];
  const generatedDirectory = path.join(root, "patchy/_generated") + path.sep;
  const companyPath = (id: string) => {
    const relative = path.relative(root, id);
    return (
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      !relative.startsWith(`node_modules${path.sep}`)
    );
  };
  const owned = (id: string) =>
    !id.startsWith("\0") &&
    (companyPath(id) || !sdkDirectories.some((directory) => id.startsWith(directory + path.sep)));
  const refuse = (source: string, importer: string, packagePath = source): never => {
    const name = packagePath.startsWith("@")
      ? packagePath.split("/").slice(0, 2).join("/")
      : packagePath.split("/")[0];
    const error = new LocalError({
      code: "import_refused",
      message: `Package ${JSON.stringify(name)} (import ${JSON.stringify(source)}) in ${path.relative(root, importer)} is not a page entry point. Allowed: ${pageEntries.join(", ")}, and the generated client at patchy/_generated/client.js. anything else, write or copy into your patch as your company's own code. See "What the SDK gives you" in .agents/skills/patchy-loop/SKILL.md.`
    });
    refused(error);
    // Bundlers mutate thrown errors; retain the CLI refusal for watch and publish.
    throw new Error(error.message);
  };
  const checkTarget = (target: string, source: string, importer: string) => {
    if (target.startsWith(path.join(root, "server") + path.sep))
      refuse(source, importer, "server/");
    const dependency = target.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (dependency !== -1 && !companyPath(target))
      refuse(source, importer, target.slice(dependency + "/node_modules/".length));
  };
  const check = (source: string, importer: string) => {
    if (!owned(importer)) return;
    if (source.startsWith(".") || source.startsWith("/")) {
      const target = source.startsWith("/")
        ? source.startsWith(root + path.sep)
          ? source
          : path.join(root, source)
        : path.resolve(path.dirname(importer), source);
      checkTarget(target, source, importer);
      return;
    }
    if (pageEntries.includes(source)) return;
    if (source === "patchy/client" && importer.startsWith(generatedDirectory)) return;
    refuse(source, importer);
  };
  return {
    name: "patchy-page-imports",
    enforce: "pre",
    buildStart() {
      refused(undefined);
    },
    transform(code, id) {
      if (!owned(id)) return;
      if (/\.css(?:\?|$)/.test(id)) {
        CssTree.walk(CssTree.parse(code), (node) => {
          if (
            node.type !== "Atrule" ||
            CssTree.ident.decode(node.name).toLowerCase() !== "import" ||
            node.prelude?.type !== "AtrulePrelude"
          )
            return;
          const value = node.prelude.children.first;
          if (value?.type !== "String" && value?.type !== "Url") return;
          // CSS permits local imports without './'; only a nonlocal bare name is a package.
          const local = path.resolve(path.dirname(id), value.value);
          if (existsSync(local)) checkTarget(local, value.value, id);
          else check(value.value, id);
        });
        return;
      }
      if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id) && !id.includes("html-proxy")) return;
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          const onlyTypes =
            clause?.isTypeOnly ||
            (clause &&
              !clause.name &&
              clause.namedBindings &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.length > 0 &&
              clause.namedBindings.elements.every((entry) => entry.isTypeOnly));
          if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier))
            check(node.moduleSpecifier.text, id);
        } else if (ts.isExportDeclaration(node)) {
          const onlyTypes =
            node.isTypeOnly ||
            (node.exportClause &&
              ts.isNamedExports(node.exportClause) &&
              node.exportClause.elements.length > 0 &&
              node.exportClause.elements.every((entry) => entry.isTypeOnly));
          if (!onlyTypes && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
            check(node.moduleSpecifier.text, id);
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument)) check(argument.text, id);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    },
    async resolveId(source, importer) {
      if (!importer || source.startsWith("\0") || !owned(importer)) return;
      check(source, importer);
      if (source.startsWith(".") || source.startsWith("/")) {
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved && path.isAbsolute(resolved.id)) checkTarget(resolved.id, source, importer);
        return resolved;
      }
    }
  };
}
