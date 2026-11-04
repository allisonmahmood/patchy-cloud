import * as CssTree from "css-tree";
import * as Effect from "effect/Effect";
import * as parse5 from "parse5";
import { LocalError } from "./CliError.js";

/** The page cap, which an instance enforces by default as `PATCHY_MAX_BUNDLE_BYTES`. */
const maxBundleBytes = 10 * 1024 * 1024;

const embedded = (value: string) => /^(?:data:|#)/i.test(value.trim());

/** Inventory built resources, including templates and srcdoc documents. */
const inspectBundle = (html: string) => {
  const dependencies = new Set<string>();
  const contributors: Array<{ name: string; bytes: number }> = [];
  const css = (source: string, location: string, context: "stylesheet" | "declarationList") => {
    // CSSTree preserves escaped identifiers, but only a literal url name gets URL tokenization.
    // Normalize that token alone so quoted/unquoted embedded URLs keep their CSS semantics.
    let normalized = "";
    let copied = 0;
    if (source.includes("\\")) {
      CssTree.tokenize(source, (type, start, end) => {
        if (type !== CssTree.tokenTypes.Function) return;
        const name = source.slice(start, end - 1);
        if (!name.includes("\\") || CssTree.ident.decode(name).toLowerCase() !== "url") return;
        normalized += `${source.slice(copied, start)}url(`;
        copied = end;
      });
    }
    const ast = CssTree.parse(copied ? normalized + source.slice(copied) : source, {
      context,
      parseCustomProperty: true,
      // css-tree also reports each grammar it tries for a condition, such as Tailwind v4's
      // nested `@supports (((-webkit-hyphens:none)) …)`. A null fallback means it rereads the
      // same tokens with the next grammar, which reports again if it too fails.
      onParseError(error, fallback: CssTree.CssNode | null) {
        if (fallback !== null) throw error;
      }
    });
    CssTree.walk(ast, (node) => {
      // Unparsed syntax must never conceal a resource, including in custom properties.
      if (node.type === "Raw") dependencies.add(`${location}: unsupported CSS syntax`);
      if (node.type === "Atrule" && CssTree.ident.decode(node.name).toLowerCase() === "import")
        dependencies.add(`${location}: CSS @import`);
      if (node.type === "Url" && !embedded(node.value))
        dependencies.add(`${location}: external CSS url()`);
      if (node.type === "Function") {
        const name = CssTree.ident.decode(node.name).toLowerCase();
        if (name === "image-set" || name === "-webkit-image-set") {
          // Only direct strings are image candidates; type("image/png") is a descriptor.
          for (const child of node.children) {
            if (child.type === "String" && !embedded(child.value))
              dependencies.add(`${location}: external CSS image-set()`);
          }
        }
      }
    });
  };
  const srcset = (value: string) => {
    // URL tokens may contain commas (notably data URLs); descriptors end at the next comma.
    let rest = value.trimStart();
    while (rest) {
      const token = /^\S+/.exec(rest)?.[0] ?? "";
      if (!embedded(token.replace(/,+$/, ""))) return false;
      rest = rest.slice(token.length).trimStart();
      if (!token.endsWith(",")) {
        const comma = rest.indexOf(",");
        rest = comma < 0 ? "" : rest.slice(comma + 1).trimStart();
      }
    }
    return true;
  };
  const walk = (node: parse5.DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const tag = node.tagName;
      for (const attr of node.attrs) {
        const name = attr.name;
        const location = `<${tag}> ${attr.prefix ? `${attr.prefix}:` : ""}${name}`;
        if (name === "srcdoc") walk(parse5.parseFragment(attr.value));
        const value = attr.value.trim();
        if (name === "style") css(value, location, "declarationList");
        if (name === "srcset" || name === "imagesrcset") {
          if (!srcset(value)) dependencies.add(`${location} is not embedded`);
        }
        if (
          name === "src" ||
          name === "poster" ||
          name === "background" ||
          (tag === "object" && name === "data")
        ) {
          if (tag === "script" || !embedded(value)) dependencies.add(`${location} is not embedded`);
        }
        if (name === "href") {
          const navigation = tag === "a" || tag === "area";
          if (tag === "link" || tag === "script" || (!navigation && !embedded(value)))
            dependencies.add(`${location} is unsupported`);
        }
        if (/^data:/i.test(value))
          contributors.push({ name: location, bytes: Buffer.byteLength(value) });
      }
      if (tag === "script" || tag === "style") {
        const text = node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
        contributors.push({ name: `inline <${tag}>`, bytes: Buffer.byteLength(text) });
        if (tag === "style") css(text, "<style>", "stylesheet");
      }
      if ("content" in node) walk(node.content);
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
  };
  walk(parse5.parse(html));
  contributors.push({
    name: "HTML markup and text",
    bytes: Math.max(
      0,
      Buffer.byteLength(html) - contributors.reduce((total, entry) => total + entry.bytes, 0)
    )
  });
  return {
    dependencies: [...dependencies],
    contributors: contributors.sort((a, b) => b.bytes - a.bytes).slice(0, 5)
  };
};

/**
 * A page's HTML carries every resource it uses and fits the page cap. Repo builds, watched dev
 * builds and single-file publishes all check it here, before anything is sent.
 */
export const checkBundle = Effect.fn("checkBundle")(function* (html: string) {
  const inspection = yield* Effect.try({
    try: () => inspectBundle(html),
    catch: (cause) =>
      new LocalError({
        message:
          "Could not inspect the HTML bundle. Use valid, supported CSS with embedded resources.",
        cause
      })
  });
  if (inspection.dependencies.length)
    return yield* new LocalError({
      message: `The HTML bundle is not self-contained or uses unsupported external dependencies:\n- ${inspection.dependencies.join("\n- ")}\nInline every resource in the HTML, for example as a data: URL.`
    });
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBundleBytes)
    return yield* new LocalError({
      message: `HTML bundle is ${bytes} bytes; maximum is ${maxBundleBytes} bytes. Largest contributors:\n${inspection.contributors.map((entry) => `- ${entry.name}: ${entry.bytes} bytes`).join("\n")}\nReduce these resources before publishing.`,
      code: "too_large"
    });
});
