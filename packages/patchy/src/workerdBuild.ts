import { CST, type Document, isMap, isScalar, Lexer, parseDocument, visit } from "yaml";

const workerdBuild = [
  "# Patchy runs workerd's binary itself; its install script is not needed.",
  "allowBuilds:",
  "  workerd: false",
  ""
];
/** pnpm's build keys are package names, optionally with a version: `workerd@1.2.3`. */
const choosesWorkerd = (key: string) => /^workerd(@|$)/.test(key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** YAML that gives a splice somewhere else to land: anchors, aliases, tags, `?` keys, documents. */
const intricate = new Set([
  "anchor",
  "alias",
  "tag",
  "explicit-key-ind",
  "doc-start",
  "doc-end",
  "directive-line"
]);
/** The settings as pnpm reads them, aliases and merges resolved; undefined when it can't. */
const settingsOf = (document: Document): unknown => {
  if (document.errors.length > 0) return undefined;
  try {
    return document.toJS();
  } catch {
    return undefined;
  }
};
const hasMergeKey = (document: Document) => {
  let found = false;
  visit(document, {
    Pair: (_, pair) => {
      if (isScalar(pair.key) && (typeof pair.key.value === "symbol" || pair.key.value === "<<")) {
        found = true;
        return visit.BREAK;
      }
    }
  });
  return found;
};
const columnOf = (source: string, at: number) => at - (source.lastIndexOf("\n", at - 1) + 1);
const addBuildsNotice = (action: string) =>
  `${action}: until then pnpm 12 fails install, add and remove on workerd's build script. Refresh leaves that file as written because of how its YAML is laid out.`;

/**
 * What refresh does with a repo's pnpm-workspace.yaml so pnpm 12, which fails `install`, `add`
 * and `remove` when it ignores a build script, never trips on workerd's: Patchy runs workerd's
 * platform binary directly. A choice the repo made for workerd, through aliases or merges too,
 * is kept. Otherwise `workerd: false` is spliced into the plain layouts the scaffold and hand
 * edits produce: one document whose block mapping starts at column 0, with no anchors, aliases,
 * merge keys, `?` keys, tags or document markers, and `allowBuilds` absent, a block mapping or a
 * one-line flow mapping. Any other file is left byte for byte, with a notice naming the line to add.
 */
export function withWorkerdBuildDeclined(
  source: string
): { readonly source: string } | { readonly notice: string } {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const splice = (at: number, text: string, end = at) => ({
    source: `${source.slice(0, at)}${text}${source.slice(end)}`
  });
  const document = parseDocument(source, { merge: true });
  const root = document.contents;
  const settings = settingsOf(document);
  const builds = isRecord(settings) ? settings.allowBuilds : undefined;
  if (isRecord(builds) && Object.keys(builds).some(choosesWorkerd)) return { source };
  const setting = isMap(root)
    ? root.items.find((pair) => isScalar(pair.key) && pair.key.value === "allowBuilds")
    : undefined;
  const plain =
    settings !== undefined &&
    !hasMergeKey(document) &&
    ![...new Lexer().lex(source)].some((lexeme) => intricate.has(CST.tokenType(lexeme) ?? "")) &&
    (root === null || (isMap(root) && !root.flow && columnOf(source, root.range[0]) === 0));
  const value = setting?.value;
  if (plain && setting === undefined)
    return {
      source: `${source}${source === "" || source.endsWith("\n") ? "" : eol}${workerdBuild.join(eol)}`
    };
  if (plain && isMap(value) && !value.flow && isScalar(value.items[0]?.key)) {
    // Its own line, indented like the mapping's first entry.
    const at = value.items[0].key.range![0];
    const line = source.lastIndexOf("\n", at - 1) + 1;
    return splice(line, `${source.slice(line, at)}workerd: false${eol}`);
  }
  if (plain && isMap(value) && value.flow) {
    const [open, close] = value.range!;
    if (!source.slice(open, close).includes("\n"))
      return isScalar(value.items[0]?.key)
        ? splice(value.items[0].key.range![0], "workerd: false, ")
        : splice(open, "{ workerd: false }", close);
  }
  const named = settings === undefined ? setting !== undefined : builds !== undefined;
  return {
    notice: addBuildsNotice(
      named
        ? "Add `workerd: false` under `allowBuilds` in pnpm-workspace.yaml"
        : "Add the top-level line `allowBuilds: { workerd: false }` to pnpm-workspace.yaml"
    )
  };
}
