/**
 * A company look's publish checks, the one pure module `patchy look publish`, the instance's
 * publish route and the local preview all run, so the CLI and the server refuse the same looks.
 * A look revision is three text files: `look.css`, `LOOK.md` and an optional `logo.svg`, with
 * fonts embedded in `look.css` as `data:` URLs. Browser-safe.
 */
import * as CssTree from "css-tree";
import * as parse5 from "parse5";
import { registry } from "@patchy/limits/registry";

/** The fifteen tokens every look sets. Patchy fixes the names and meanings; the company sets the values. */
export const LOOK_TOKENS = [
  "bg",
  "surface",
  "fg",
  "muted",
  "link",
  "success",
  "warning",
  "danger",
  "accent",
  "accent-fg",
  "border",
  "font-body",
  "font-display",
  "radius",
  "space"
] as const;
export type LookToken = (typeof LOOK_TOKENS)[number];

/** A look revision's files by name, as `patchy look --json` returns them and publish sends them. */
export interface LookFiles {
  readonly "look.css": string;
  readonly "LOOK.md": string;
  readonly "logo.svg"?: string;
}

const COLOURS: ReadonlySet<string> = new Set<LookToken>([
  "bg",
  "surface",
  "fg",
  "muted",
  "link",
  "success",
  "warning",
  "danger",
  "accent",
  "accent-fg",
  "border"
]);
/** Each text colour on both grounds, then text on the accent fill. */
const CONTRAST_PAIRS: ReadonlyArray<readonly [LookToken, LookToken]> = [
  ...(["fg", "muted", "link", "success", "warning", "danger"] as const).flatMap(
    (text) =>
      [
        [text, "bg"],
        [text, "surface"]
      ] as const
  ),
  ["accent-fg", "accent"]
];
const MIN_CONTRAST = 4.5;
const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;
const TOKEN_PREFIX = "--look-";
const isToken = (name: string): name is LookToken =>
  (LOOK_TOKENS as readonly string[]).includes(name);

/** WCAG 2 relative luminance of an opaque `#RRGGBB`. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
const isData = (target: string) => /^data:/i.test(target.trim());

/** Functions whose string arguments are image addresses, like a `url()`. */
const STRING_URL_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "src"]);

/**
 * What a stylesheet points outside itself at: each `@import` target, every other `url()`, and
 * the string addresses inside `image-set()` and `src()`.
 */
const cssReferences = (ast: CssTree.CssNode) => {
  const found: Array<{
    readonly line?: number;
    readonly target: string;
    readonly imported: boolean;
  }> = [];
  CssTree.walk(ast, function (node) {
    const line = node.loc?.start.line;
    if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
      const target = node.prelude?.type === "AtrulePrelude" ? node.prelude.children.first : null;
      found.push({
        ...(line === undefined ? {} : { line }),
        target: target?.type === "String" || target?.type === "Url" ? target.value : "",
        imported: true
      });
    } else if (node.type === "Url" && this.atrule?.name.toLowerCase() !== "import") {
      found.push({ ...(line === undefined ? {} : { line }), target: node.value, imported: false });
    } else if (node.type === "Function" && STRING_URL_FUNCTIONS.has(node.name.toLowerCase())) {
      node.children.forEach((child) => {
        if (child.type === "String")
          found.push({
            ...(child.loc === undefined ? {} : { line: child.loc.start.line }),
            target: child.value,
            imported: false
          });
      });
    }
  });
  return found;
};

type Declared = { readonly line: number; readonly value: string };

/**
 * The checks over `look.css`: syntax, the layer, escapes, references, `!important` and the
 * tokens. Only a token declared in a `:root` rule directly inside `@layer look` counts, so no
 * media query, class or registration can change what a token is.
 */
const checkCss = (css: string): string[] => {
  const errors: string[] = [];
  const at = (line: number | undefined) => `look.css${line === undefined ? "" : `:${line}`}`;
  const ast = CssTree.parse(css, {
    positions: true,
    parseCustomProperty: true,
    onParseError: (error) => {
      errors.push(`${at(error.line)} could not be parsed: ${error.message.replace(/\.?$/, ".")}`);
    }
  });

  // Unlayered CSS beats every layer, so the look stays in its own and a patch's own CSS wins.
  const effective = new Set<CssTree.CssNode>();
  if (ast.type === "StyleSheet") {
    ast.children.forEach((node) => {
      if (node.type === "Atrule") {
        const name = node.name.toLowerCase();
        const prelude = node.prelude === null ? "" : CssTree.generate(node.prelude);
        if (name === "layer" && prelude === "look") {
          node.block?.children.forEach((rule) => {
            if (rule.type === "Rule" && CssTree.generate(rule.prelude) === ":root")
              rule.block.children.forEach((declaration) => effective.add(declaration));
          });
          return;
        }
        // An @import is refused below, for what it imports.
        if (name === "font-face" || name === "charset" || name === "import") return;
        errors.push(
          `${at(node.loc?.start.line)} has @${name}${name === "layer" ? ` ${prelude}` : ""} outside @layer look; only @font-face may sit outside it.`
        );
      } else if (node.type === "Rule") {
        errors.push(
          `${at(node.loc?.start.line)} has a rule outside @layer look; only @font-face may sit outside it.`
        );
      }
    });
  }

  // Escaped names would slip past every check by name; honest CSS never escapes one.
  CssTree.walk(ast, (node) => {
    const line = node.loc?.start.line;
    const name =
      node.type === "Declaration"
        ? node.property
        : node.type === "Function"
          ? node.name
          : node.type === "Atrule"
            ? `@${node.name}`
            : "";
    if (name.includes("\\"))
      errors.push(`${at(line)} escapes ${name} with a backslash; write names plainly.`);
    if (
      node.type === "Atrule" &&
      node.name.toLowerCase() === "property" &&
      node.prelude !== null &&
      CssTree.generate(node.prelude).startsWith(TOKEN_PREFIX)
    )
      errors.push(
        `${at(line)} registers @property ${CssTree.generate(node.prelude)}; tokens are plain custom properties.`
      );
  });

  for (const { line, target, imported } of cssReferences(ast)) {
    if (imported)
      errors.push(`${at(line)} imports "${target}"; a look is one self-contained file.`);
    else if (!isData(target))
      errors.push(`${at(line)} references ${target}; every URL must be a data: URL.`);
  }

  const declared = new Map<LookToken, Declared[]>();
  CssTree.walk(ast, {
    visit: "Declaration",
    enter: (node) => {
      const line = node.loc?.start.line ?? 0;
      if (node.important !== false)
        errors.push(
          `${at(line)} uses !important; a patch's own CSS must always win over the look.`
        );
      if (!node.property.startsWith(TOKEN_PREFIX)) return;
      const token = node.property.slice(TOKEN_PREFIX.length);
      if (!isToken(token))
        errors.push(`${at(line)} declares ${node.property}, which is not a look token.`);
      else if (!effective.has(node))
        errors.push(
          `${at(line)} declares ${node.property} outside :root in @layer look; declare tokens only there.`
        );
      else {
        const value = CssTree.generate(node.value).trim();
        declared.set(token, [...(declared.get(token) ?? []), { line, value }]);
      }
    }
  });

  const colours = new Map<LookToken, string>();
  for (const token of LOOK_TOKENS) {
    const found = declared.get(token) ?? [];
    if (found.length === 0) errors.push(`look.css is missing ${TOKEN_PREFIX}${token}.`);
    if (found.length > 1)
      errors.push(
        `look.css declares ${TOKEN_PREFIX}${token} ${found.length === 2 ? "twice" : `${found.length} times`}, on lines ${found.map(({ line }) => line).join(" and ")}; declare each token once.`
      );
    for (const { line, value } of found) {
      if (value === "") errors.push(`${at(line)} gives ${TOKEN_PREFIX}${token} no value.`);
      else if (COLOURS.has(token) && !OPAQUE_HEX.test(value))
        errors.push(
          `${at(line)} sets ${TOKEN_PREFIX}${token} to ${value}; colours must be opaque #RRGGBB.`
        );
    }
    const [only] = found;
    if (found.length === 1 && only !== undefined && OPAQUE_HEX.test(only.value))
      colours.set(token, only.value);
  }

  for (const [text, ground] of CONTRAST_PAIRS) {
    const [fore, back] = [colours.get(text), colours.get(ground)];
    if (fore === undefined || back === undefined) continue;
    const ratio = contrast(fore, back);
    if (ratio < MIN_CONTRAST)
      errors.push(
        `${TOKEN_PREFIX}${text} on ${TOKEN_PREFIX}${ground} is ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1; text colours need ${MIN_CONTRAST}:1.`
      );
  }
  return errors;
};

/** The logo is one `<svg>` that embeds anything it shows; `#fragment` links stay inside it. */
const checkLogo = (svg: string): string[] => {
  const roots = parse5
    .parseFragment(svg)
    .childNodes.filter(
      (node) => node.nodeName !== "#comment" && !("value" in node && node.value.trim() === "")
    );
  const [root] = roots;
  if (roots.length !== 1 || root?.nodeName !== "svg")
    return ["logo.svg must be one <svg> element."];
  const errors: string[] = [];
  const targets: string[] = [];
  const css = (text: string, context: string) => {
    for (const { target } of cssReferences(CssTree.parse(text, { context }))) targets.push(target);
  };
  const visit = (node: parse5.DefaultTreeAdapterMap["childNode"]) => {
    if (!("tagName" in node)) return;
    const tag = node.tagName.toLowerCase();
    for (const { name, value } of node.attrs) {
      if (/^on/i.test(name))
        errors.push(`logo.svg has an ${name} attribute; a logo is a picture, not a program.`);
      else if (name === "href" || name === "src") targets.push(value);
      else if (name === "style") css(value, "declarationList");
      else if (/url\(/i.test(value)) css(value, "value");
    }
    if (tag === "script")
      errors.push("logo.svg has a <script>; a logo is a picture, not a program.");
    if (tag === "foreignobject")
      errors.push("logo.svg has a <foreignObject>; draw the logo in SVG.");
    if (tag === "style")
      css(
        node.childNodes
          .map((child: parse5.DefaultTreeAdapterMap["childNode"]) =>
            "value" in child ? child.value : ""
          )
          .join(""),
        "stylesheet"
      );
    node.childNodes.forEach(visit);
  };
  visit(root);
  return [
    ...errors,
    ...targets
      .filter((target) => !isData(target) && !target.trim().startsWith("#"))
      .map((target) => `logo.svg references ${target}; embed it as a data: URL.`)
  ];
};

/**
 * Every reason a look cannot be published, each naming the file and what to change; empty when
 * it passes. The checks are the token set, opaque colours, `!important`, WCAG contrast,
 * self-containment and the limits registry's sizes.
 */
export const checkLook = (files: LookFiles): ReadonlyArray<string> => {
  // Postgres text cannot hold NUL, and no stylesheet, brief or logo needs one.
  const nul = Object.entries(files)
    .filter(([, text]) => text.includes("\u0000"))
    .map(([name]) => `${name} contains a NUL character.`);
  if (nul.length > 0) return nul;
  const errors = checkCss(files["look.css"]);
  if (files["logo.svg"] !== undefined) errors.push(...checkLogo(files["logo.svg"]));
  const briefBytes = utf8Bytes(files["LOOK.md"]);
  const briefLimit = registry["look.brief.bytes"].default;
  if (files["LOOK.md"].trim() === "") errors.push("LOOK.md is empty.");
  else if (briefBytes > briefLimit)
    errors.push(`LOOK.md is ${kib(briefBytes)}; the limit is ${briefLimit / 1024} KiB.`);
  const bytes = utf8Bytes(files["look.css"]) + briefBytes + utf8Bytes(files["logo.svg"] ?? "");
  const limit = registry["look.bytes"].default;
  if (bytes > limit)
    errors.push(
      `The look is ${kib(bytes)}; the limit is ${limit / 1024} KiB, embedded fonts included.`
    );
  return errors;
};
