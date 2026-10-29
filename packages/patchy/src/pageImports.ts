// @effect-diagnostics nodeBuiltinImport:off -- Vite module ids and the installed SDK use Node paths.
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import type { Node } from "@babel/types";
import * as CssTree from "css-tree";
import * as parse5 from "parse5";
import type { Plugin, ResolveFn } from "vite";
import { SDK_ENTRY_POINTS } from "@patchy/api";
import { LocalError } from "./CliError.js";

const modulePreloadPolyfill = "vite/modulepreload-polyfill";

// The script types HTML runs as classic JavaScript; an empty type means the default.
const javascriptType =
  /^(?:|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript))$/;

// Babel marks each AST node with a string `type`; locations and plain values have none.
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

/** Check each authored graph before aliases, tree shaking, or resolution hide imports. */
export function pageImports(
  root: string,
  refused: (error: LocalError | undefined) => void,
  options: { readonly graph?: "page" | "server"; readonly sdkImports?: Set<string> } = {}
): Plugin {
  const sdkDirectory = realpathSync(path.join(root, "node_modules/patchy"));
  const graph = options.graph ?? "page";
  const entries = SDK_ENTRY_POINTS[graph];
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
  // The page reaches handlers through patchy.server, never by importing their code.
  const refuseFolder = (source: string, importer: string, folder: "server" | "agent"): never => {
    const error = new LocalError({
      code: "import_refused",
      message: `${path.relative(root, importer)} imports ${JSON.stringify(source)}, but the page can't import ${folder}/ at runtime. ${
        folder === "server"
          ? "Call its handlers through patchy.server, and import their contracts with import type."
          : "Agent tools are for people's agents only; call server/ handlers through patchy.server."
      }`
    });
    refused(error);
    throw new Error(error.message);
  };
  const checkTarget = (target: string, source: string, importer: string) => {
    if (graph === "page")
      for (const folder of ["server", "agent"] as const)
        if (target.startsWith(path.join(root, folder) + path.sep))
          refuseFolder(source, importer, folder);
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
      (graph === "page" &&
        SDK_ENTRY_POINTS.generated.includes(source) &&
        importer.startsWith(generatedDirectory))
    ) {
      options.sdkImports?.add(source);
      return;
    }
    refuse(source, importer);
  };
  /**
   * Check one script's imports. HTML's inline scripts are plain JavaScript, classic or module.
   * Files read as TypeScript with decorators, and JSX except in `.ts`, `.mts` and `.cts`, where
   * its tags would read as `<T>value` type assertions.
   */
  const checkJavaScript = (code: string, id: string, inline?: "classic" | "module") => {
    const plugins: ParserPlugin[] =
      inline !== undefined || id.includes("html-proxy")
        ? ["deferredImportEvaluation"]
        : [
            "typescript",
            "decorators",
            "deferredImportEvaluation",
            ...(/\.[cm]?ts(?:\?|$)/.test(id) ? [] : (["jsx"] as const))
          ];
    const { program, errors } = parse(code, {
      sourceType: inline === "classic" ? "script" : "module",
      plugins,
      errorRecovery: true
    });
    // TypeScript's legacy parameter decorators are the one recoverable error Vite still builds.
    const error = errors.find((entry) => entry.reasonCode !== "UnsupportedParameterDecorator");
    if (error !== undefined) throw error;
    const literal = (node: Node | null | undefined) =>
      node?.type === "StringLiteral"
        ? node.value
        : node?.type === "TemplateLiteral" && node.expressions.length === 0
          ? (node.quasis[0]!.value.cooked ?? undefined)
          : undefined;
    const visit = (node: Node): void => {
      if (node.type === "ImportDeclaration") {
        const onlyTypes =
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (entry) => entry.type === "ImportSpecifier" && entry.importKind === "type"
            ));
        if (!onlyTypes) check(node.source.value, id);
      } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
        const onlyTypes =
          node.exportKind === "type" ||
          (node.type === "ExportNamedDeclaration" &&
            node.specifiers.length > 0 &&
            node.specifiers.every(
              (entry) => entry.type === "ExportSpecifier" && entry.exportKind === "type"
            ));
        if (!onlyTypes && node.source) check(node.source.value, id);
      } else if (
        node.type === "TSImportEqualsDeclaration" &&
        node.importKind !== "type" &&
        node.moduleReference.type === "TSExternalModuleReference"
      ) {
        check(node.moduleReference.expression.value, id);
      } else if (node.type === "ImportExpression") {
        // import() and import.defer() alike load a module at run time.
        if (graph === "server") {
          const error = new LocalError({
            code: "invalid_manifest",
            message: `Server bundles must be closed modules without dynamic imports. Remove import() in ${path.relative(root, id)}.`
          });
          refused(error);
          throw new Error(error.message);
        }
        const source = literal(node.source);
        if (source !== undefined) check(source, id);
      } else if (
        (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const [argument] = node.arguments;
        const source = argument?.type === "SpreadElement" ? undefined : literal(argument);
        if (source !== undefined) check(source, id);
      }
      const values: ReadonlyArray<unknown> = Object.values(node);
      for (const value of values)
        for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child);
    };
    visit(program);
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
            const type = node.attrs
              .find((attribute) => attribute.name === "type")
              ?.value.trim()
              .toLowerCase();
            if (src) {
              if (type === "module") check(src.value, id);
            } else if (type === "module" || type === undefined || javascriptType.test(type)) {
              // Any other type, such as JSON or an import map, is a data block browsers never run.
              for (const child of node.childNodes)
                if (child.nodeName === "#text" && "value" in child)
                  checkJavaScript(child.value, id, type === "module" ? "module" : "classic");
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
