import * as parse5 from "parse5";
import type { HtmlValidationResult } from "./types.js";

const BLOCKED_TAG_LOOKUP = {
  script: true,
  form: true,
  iframe: true,
  object: true,
  embed: true,
  applet: true,
  base: true,
  link: true
} as const satisfies Record<string, true>;

type BlockedTag = keyof typeof BLOCKED_TAG_LOOKUP;

export const BLOCKED_TAGS = Object.freeze(Object.keys(BLOCKED_TAG_LOOKUP) as BlockedTag[]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "srcdoc",
  "xlink:href"
]);

export const BLOCKED_PROTOCOLS = ["javascript:", "vbscript:", "file:"] as const;

export const DEFAULT_MAX_HTML_BYTES = 512 * 1024;

export interface ValidateHtmlOptions {
  maxBytes?: number;
}

export function validateHtml(
  html: string,
  options: ValidateHtmlOptions = {}
): HtmlValidationResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_HTML_BYTES;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof html !== "string" || html.trim() === "") {
    errors.push("HTML document is empty.");
    return { ok: false, errors, warnings, title: null };
  }

  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > maxBytes) {
    errors.push(`HTML document is ${byteLength} bytes; maximum is ${maxBytes} bytes.`);
  }

  let document: parse5.DefaultTreeAdapterMap["document"];
  try {
    document = parse5.parse(html);
  } catch {
    errors.push("HTML document could not be parsed.");
    return { ok: false, errors, warnings, title: null };
  }

  function walk(node: HtmlNode): void {
    if ("tagName" in node && node.tagName) {
      const tagName = node.tagName.toLowerCase();

      if (Object.hasOwn(BLOCKED_TAG_LOOKUP, tagName)) {
        errors.push(`Blocked <${tagName}> tag found.`);
      }

      for (const attr of node.attrs || []) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "").trim();

        if (name.startsWith("on")) {
          errors.push(`Blocked inline event handler attribute "${name}" found.`);
        }

        if (name === "srcdoc") {
          errors.push('Blocked "srcdoc" attribute found.');
        }

        if (URL_ATTRS.has(name)) {
          const normalized = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
          if (BLOCKED_PROTOCOLS.some((protocol) => normalized.startsWith(protocol))) {
            errors.push(`Blocked unsafe URL in "${name}" attribute.`);
          }
        }

        if (
          name === "style" &&
          /expression\s*\(|behavior\s*:|url\s*\(\s*javascript:/i.test(value)
        ) {
          errors.push("Blocked unsafe inline CSS.");
        }
      }

      if (tagName === "meta") {
        const httpEquiv = (node.attrs || []).find(
          (attr) => attr.name.toLowerCase() === "http-equiv"
        );
        if (httpEquiv && httpEquiv.value.trim().toLowerCase() === "refresh") {
          errors.push("Blocked meta refresh tag found.");
        }
      }
    }

    if ("childNodes" in node) {
      for (const child of node.childNodes || []) {
        walk(child);
      }
    }
  }

  walk(document);

  const title = firstTitle(document, false);
  if (!title) {
    warnings.push("No <title> found; Patchy Cloud will use a generic title.");
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    title
  };
}

type HtmlNode = parse5.DefaultTreeAdapterMap["node"];

/** A scripted bundle's title comes before its inline code, which runs to megabytes. */
const TITLE_SEARCH_CHARACTERS = 64 * 1024;

/**
 * A scripted page's title, for publish and `patchy dev`; tier 0's comes from `validateHtml`. Only
 * the start of the bundle is read, which also bounds parse5, whose cost grows with the square of
 * nesting depth. A title past that limit, or cut by it, gives null.
 */
export function documentTitle(html: string): string | null {
  const cut = html.length > TITLE_SEARCH_CHARACTERS;
  const document = parse5.parse(html.slice(0, TITLE_SEARCH_CHARACTERS), {
    sourceCodeLocationInfo: cut
  });
  return firstTitle(document, cut);
}

/**
 * The title as a browser picks it: the first HTML `<title>`, trimmed and bounded, or null when
 * it is missing or empty. In a document cut short, only a title whose end tag survived counts.
 */
function firstTitle(document: HtmlNode, cut: boolean): string | null {
  // parse5 builds deep trees without recursion; walking one must not recurse either.
  const pending: HtmlNode[] = [document];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTitle(node)) {
      if (cut && !node.sourceCodeLocation?.endTag) return null;
      return collectText(node).trim().slice(0, 140) || null;
    }
    if ("childNodes" in node)
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!);
  }
  return null;
}

/** An SVG's `<title>` labels the drawing, not the document. */
function isTitle(node: HtmlNode): node is parse5.DefaultTreeAdapterMap["element"] {
  return "tagName" in node && node.tagName === "title" && node.namespaceURI === parse5.html.NS.HTML;
}

function collectText(node: HtmlNode): string {
  let value = "";
  if ("childNodes" in node) {
    for (const child of node.childNodes || []) {
      if (child.nodeName === "#text" && "value" in child) {
        value += child.value || "";
      }
      value += collectText(child);
    }
  }
  return value;
}
