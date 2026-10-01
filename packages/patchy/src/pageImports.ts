// @effect-diagnostics nodeBuiltinImport:off -- Vite module ids and the installed SDK use Node paths.
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as CssTree from "css-tree";
import * as parse5 from "parse5";
import ts from "typescript";
import type { Plugin, ResolveFn } from "vite";
import { LocalError } from "./CliError.js";

const pageEntries = [
  "patchy/preact",
  "patchy/preact/jsx-runtime",
  "patchy/preact/jsx-dev-runtime",
  "patchy/csv"
];
const serverEntries = ["patchy/server", "patchy/csv"];
const modulePreloadPolyfill = "vite/modulepreload-polyfill";

/** Check each authored graph before aliases, tree shaking, or resolution hide imports. */
export function pageImports(
  root: string,
  refused: (error: LocalError | undefined) => void,
  options: { readonly graph?: "page" | "server"; readonly sdkImports?: Set<string> } = {}
): Plugin {
  const sdkDirectory = realpathSync(path.join(root, "node_modules/patchy"));
  const graph = options.graph ?? "page";
  const entries = graph === "page" ? pageEntries : serverEntries;
  const sdkDirectories = [
    sdkDirectory,
    ...(graph === "page"
      ? ["preact", "@preact/signals", "@preact/signals-core"].map((name) =>
          realpathSync(path.join(sdkDirectory, "node_modules", name))
        )
      : [])
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
  const shouldCheckSource = (id: string) =>
    !id.startsWith("\0") &&
    (companyPath(id) || !sdkDirectories.some((directory) => id.startsWith(directory + path.sep)));
  const refuse = (source: string, importer: string, packagePath = source): never => {
    const name = packagePath.startsWith("@")
      ? packagePath.split("/").slice(0, 2).join("/")
      : packagePath.split("/")[0];
    const error = new LocalError({
      code: "import_refused",
      message: `Package ${JSON.stringify(name)} (import ${JSON.stringify(source)}) in ${path.relative(root, importer)} is not a ${graph} entry point. Allowed: ${entries.join(", ")}${graph === "page" ? ", and the generated client at patchy/_generated/client.js" : ""}. anything else, write or copy into your patch as your company's own code. See "What the SDK gives you" in .agents/skills/patchy-loop/SKILL.md.`
    });
    refused(error);
    // Bundlers mutate thrown errors; retain the CLI refusal for watch and publish.
    throw new Error(error.message);
  };
  const checkTarget = (target: string, source: string, importer: string) => {
    if (graph === "page" && target.startsWith(path.join(root, "server") + path.sep))
      refuse(source, importer, "server/");
    const dependency = target.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (dependency !== -1 && !companyPath(target))
      refuse(source, importer, target.slice(dependency + "/node_modules/".length));
  };
  const check = (source: string, importer: string) => {
    if (!shouldCheckSource(importer)) return;
    if (source.startsWith(".") || source.startsWith("/")) {
      const target = source.startsWith("/")
        ? source.startsWith(root + path.sep)
          ? source
          : path.join(root, source)
        : path.resolve(path.dirname(importer), source);
      checkTarget(target, source, importer);
      return;
    }
    if (
      entries.includes(source) ||
      (graph === "page" && source === "patchy/client" && importer.startsWith(generatedDirectory))
    ) {
      options.sdkImports?.add(source);
      return;
    }
    refuse(source, importer);
  };
  const checkJavaScript = (code: string, id: string) => {
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
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const argument = node.moduleReference.expression;
        if (argument && ts.isStringLiteralLike(argument)) check(argument.text, id);
      } else if (ts.isCallExpression(node)) {
        const target = node.expression;
        const moduleCall =
          target.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(target) && target.text === "require") ||
          (ts.isMetaProperty(target) &&
            target.keywordToken === ts.SyntaxKind.ImportKeyword &&
            target.name.text === "defer");
        if (graph === "server" && target.kind === ts.SyntaxKind.ImportKeyword) {
          const error = new LocalError({
            code: "invalid_manifest",
            message: `Server bundles must be closed modules without dynamic imports. Remove import() in ${path.relative(root, id)}.`
          });
          refused(error);
          throw new Error(error.message);
        }
        const argument = node.arguments[0];
        if (moduleCall && argument && ts.isStringLiteralLike(argument)) check(argument.text, id);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  let resolveCss: ResolveFn;
  let publicDirectory: string;
  return {
    name: `patchy-${graph}-imports`,
    enforce: "pre",
    configResolved(config) {
      // Use the builder's resolver, including its CSS extensions and aliases.
      resolveCss = config.createResolver({
        extensions: [".css"],
        mainFields: ["style"],
        conditions: ["style", "development|production"],
        tryIndex: false,
        preferRelative: true
      });
      publicDirectory = config.publicDir;
    },
    buildStart() {
      refused(undefined);
    },
    async transform(code, id) {
      if (!shouldCheckSource(id)) return;
      if (/\.html$/.test(id)) {
        // Inspect authored scripts before Vite turns HTML into a module and adds its polyfill.
        const visit = (node: parse5.DefaultTreeAdapterMap["node"]) => {
          if ("tagName" in node && node.tagName === "script") {
            const src = node.attrs.find((attribute) => attribute.name === "src");
            if (src) {
              if (
                node.attrs.some(
                  (attribute) => attribute.name === "type" && attribute.value === "module"
                )
              )
                check(src.value, id);
            } else {
              for (const child of node.childNodes)
                if (child.nodeName === "#text" && "value" in child)
                  checkJavaScript(child.value, id);
            }
          }
          if ("childNodes" in node) for (const child of node.childNodes) visit(child);
        };
        visit(parse5.parse(code));
        return;
      }
      if (/\.css(?:\?|$)/.test(id)) {
        // Vite inlines nested @imports without giving them their own transform hook.
        // Keep traversal state local so every rebuild rereads watched dependencies.
        const visited = new Set<string>();
        const visit = async (code: string, id: string): Promise<void> => {
          const file = id.replace(/[?#].*$/, "");
          if (visited.has(file)) return;
          visited.add(file);
          const imports: string[] = [];
          CssTree.walk(CssTree.parse(code), (node) => {
            if (
              node.type !== "Atrule" ||
              CssTree.ident.decode(node.name).toLowerCase() !== "import" ||
              node.prelude?.type !== "AtrulePrelude"
            )
              return;
            const value = node.prelude.children.first;
            if (value?.type === "String" || value?.type === "Url") imports.push(value.value);
          });
          for (const source of imports) {
            // CSS permits local imports without './'; aliases must not hide package names.
            const local = path.resolve(path.dirname(file), source);
            if (existsSync(local)) checkTarget(local, source, file);
            else check(source, file);
            const publicFile =
              publicDirectory && source.startsWith("/")
                ? path.join(publicDirectory, source)
                : undefined;
            const resolved =
              publicFile && existsSync(publicFile) ? publicFile : await resolveCss(source, file);
            if (!resolved || !path.isAbsolute(resolved)) continue;
            const dependency = resolved.replace(/[?#].*$/, "");
            checkTarget(dependency, source, file);
            if (!shouldCheckSource(dependency) || visited.has(dependency)) continue;
            this.addWatchFile(dependency);
            await visit(await readFile(dependency, "utf8"), dependency);
          }
        };
        await visit(code, id);
        return;
      }
      if (/\.[cm]?[jt]sx?(?:\?|$)/.test(id) || id.includes("html-proxy")) checkJavaScript(code, id);
    },
    async resolveId(source, importer) {
      if (!importer || source.startsWith("\0") || !shouldCheckSource(importer)) return;
      // Only HTML's generated entry gets this import. Authored HTML and JS were checked above.
      if (source === modulePreloadPolyfill && /\.html$/.test(importer)) return;
      check(source, importer);
      if (source.startsWith(".") || source.startsWith("/")) {
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved && path.isAbsolute(resolved.id)) checkTarget(resolved.id, source, importer);
        return resolved;
      }
    }
  };
}
