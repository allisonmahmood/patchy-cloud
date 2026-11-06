/**
 * HTML mail as inert text, best-effort and lossy. One pass over the markup keeps a stack of open
 * elements, so what a rendered page wouldn't show stays out: `script`, `style` and the other raw
 * text elements, `template` and `svg`, and any element marked `hidden` or styled invisible
 * (`display: none`, `visibility: hidden`, `mso-hide: all`, zero opacity or font size, or zero
 * height or width with `overflow: hidden`). Links keep their `http`, `https` or `mailto` target
 * in parentheses after their text. Images, forms and table layout are dropped.
 *
 * It builds no tree, and repairs markup only where that decides what shows: a paragraph, list
 * item, cell or link ends the open one, as a browser's parser ends it. Hostile markup costs time in
 * proportion to its length: each tag is read once, and an end tag pops only elements it pushed.
 */

/** Elements with no content or end tag. */
const VOID = new Set(
  "area base br col embed hr img input keygen link meta param source track wbr".split(" ")
);
/** Raw text elements whose content never shows. */
const DROPPED_RAW = new Set(["script", "style", "title", "iframe", "noembed", "noframes"]);
/** Raw text elements whose content shows as written. */
const KEPT_RAW = new Set(["textarea", "xmp"]);
/** Elements whose whole content isn't rendered. */
const UNRENDERED = new Set(["template", "svg"]);
/** Elements that start and end a paragraph. */
const PARAGRAPHS = new Set("p h1 h2 h3 h4 h5 h6 blockquote pre table ul ol dl".split(" "));
/** Elements that start and end a line. */
const LINES = new Set(
  "address article aside caption center dd details dialog div dt fieldset figcaption figure footer form header hr li main nav section summary tbody tfoot thead tr".split(
    " "
  )
);
/** Start tags that end an open `p`, as a browser's parser does. */
const CLOSES_P = new Set([...PARAGRAPHS, ...LINES]);
/** Start tags that end an open sibling of their own group. */
const SIBLINGS = new Map<string, ReadonlyArray<string>>([
  ["li", ["li"]],
  ["dt", ["dt", "dd"]],
  ["dd", ["dt", "dd"]],
  ["option", ["option"]],
  ["tr", ["tr", "td", "th"]],
  ["td", ["td", "th"]],
  ["th", ["td", "th"]]
]);

const TAG_NAME = /[A-Za-z][^\t\n\f\r />]*/y;
const ATTRIBUTE =
  /([^\t\n\f\r />"'=][^\t\n\f\r />"'=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]+)))?/y;
const SEPARATOR = /[\t\n\f\r /]+/y;
const rawEnd = (name: string) => new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
const RAW_ENDS = new Map([...DROPPED_RAW, ...KEPT_RAW].map((name) => [name, rawEnd(name)]));
const LINK = /^(?:https?:|mailto:)/i;
const LINK_CHARACTERS = 2048;

// ---------- entities ----------

/** HTML 4's Latin-1 names, from U+00A0 on. */
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
/**
 * The names mail uses most. A name not here stays as written: lossy, and never a guess. Full
 * HTML5 coverage would take the `entities` package, which isn't worth a dependency for this.
 */
const NAMED = new Map<string, string>([
  ...LATIN1.split(" ").map((name, index) => [name, String.fromCodePoint(0xa0 + index)] as const),
  ...Object.entries({
    amp: 0x26,
    lt: 0x3c,
    gt: 0x3e,
    quot: 0x22,
    apos: 0x27,
    OElig: 0x152,
    oelig: 0x153,
    Scaron: 0x160,
    scaron: 0x161,
    Yuml: 0x178,
    fnof: 0x192,
    circ: 0x2c6,
    tilde: 0x2dc,
    ensp: 0x2002,
    emsp: 0x2003,
    thinsp: 0x2009,
    zwnj: 0x200c,
    zwj: 0x200d,
    ndash: 0x2013,
    mdash: 0x2014,
    lsquo: 0x2018,
    rsquo: 0x2019,
    sbquo: 0x201a,
    ldquo: 0x201c,
    rdquo: 0x201d,
    bdquo: 0x201e,
    dagger: 0x2020,
    Dagger: 0x2021,
    bull: 0x2022,
    hellip: 0x2026,
    permil: 0x2030,
    prime: 0x2032,
    Prime: 0x2033,
    lsaquo: 0x2039,
    rsaquo: 0x203a,
    euro: 0x20ac,
    trade: 0x2122,
    larr: 0x2190,
    uarr: 0x2191,
    rarr: 0x2192,
    darr: 0x2193,
    harr: 0x2194,
    minus: 0x2212,
    ne: 0x2260,
    le: 0x2264,
    ge: 0x2265
  }).map(([name, code]) => [name, String.fromCodePoint(code)] as const)
]);
/** Names a browser reads without their semicolon. */
const LEGACY = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);
/** What a browser reads `&#128;` through `&#159;` as: windows-1252, not C1 controls. */
const WINDOWS_1252: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x2c6,
  0x89: 0x2030,
  0x8a: 0x160,
  0x8b: 0x2039,
  0x8c: 0x152,
  0x8e: 0x17d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x2dc,
  0x99: 0x2122,
  0x9a: 0x161,
  0x9b: 0x203a,
  0x9c: 0x153,
  0x9e: 0x17e,
  0x9f: 0x178
};
const ENTITY = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g;

const codePoint = (code: number): string =>
  code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? "�"
    : String.fromCodePoint(WINDOWS_1252[code] ?? code);

/**
 * `text` with its character references read. A legacy name without its semicolon reads as a
 * browser reads it: in text, even before more letters (`&copy2026`); in an attribute, only when
 * no letter, digit or `=` follows, so a query string such as `?a=1&copy=2` stays as written.
 */
export const decodeEntities = (text: string, attribute = false): string =>
  text.includes("&")
    ? text.replace(
        ENTITY,
        (
          match,
          decimal: string | undefined,
          hex: string | undefined,
          name: string | undefined,
          semicolon: string,
          offset: number,
          whole: string
        ) => {
          if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
          if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
          if (name === undefined) return match;
          const named = semicolon === ";" ? NAMED.get(name) : undefined;
          if (named !== undefined) return named;
          if (attribute) {
            const after = whole[offset + match.length] ?? "";
            return LEGACY.has(name) && semicolon === "" && after !== "=" ? NAMED.get(name)! : match;
          }
          const legacy = [...LEGACY].find((prefix) => name.startsWith(prefix));
          return legacy === undefined
            ? match
            : `${NAMED.get(legacy)!}${name.slice(legacy.length)}${semicolon}`;
        }
      )
    : text;

// ---------- visibility ----------

const zero = (value: string | undefined) => value !== undefined && Number.parseFloat(value) === 0;

/** Whether an inline style hides its element, as mail uses styles to hide preheaders and bait. */
const styleHides = (style: string): boolean => {
  const declared = new Map<string, string>();
  for (const declaration of style
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    declared.set(
      declaration.slice(0, colon).trim(),
      declaration
        .slice(colon + 1)
        .replace(/!\s*important/g, "")
        .trim()
    );
  }
  const clipped = declared.get("overflow") === "hidden";
  return (
    declared.get("display") === "none" ||
    declared.get("visibility") === "hidden" ||
    declared.get("visibility") === "collapse" ||
    declared.get("mso-hide") === "all" ||
    zero(declared.get("opacity")) ||
    zero(declared.get("font-size")) ||
    (clipped &&
      (zero(declared.get("height")) ||
        zero(declared.get("max-height")) ||
        zero(declared.get("width")) ||
        zero(declared.get("max-width"))))
  );
};

const hides = (name: string, attributes: ReadonlyMap<string, string>): boolean =>
  UNRENDERED.has(name) ||
  attributes.has("hidden") ||
  (name === "dialog" && !attributes.has("open")) ||
  styleHides(attributes.get("style") ?? "");

// ---------- output ----------

/** Text as a page lays it out: runs of white space as one space, blocks on their own lines. */
class Output {
  private readonly parts: string[] = [];
  private breaks = 0;
  private space = false;

  /** Where the output is now, to read what was written since. */
  mark(): number {
    return this.parts.length;
  }
  since(mark: number): string {
    return this.parts.slice(mark).join("");
  }
  /** Ends the line, or the paragraph with a blank line. */
  block(lines: 1 | 2) {
    this.breaks = Math.max(this.breaks, lines);
  }
  /** A `<br>`: one more line break, up to a blank line. */
  lineBreak() {
    this.breaks = Math.min(2, this.breaks + 1);
  }
  gap() {
    this.space = true;
  }
  text(value: string, preformatted: boolean) {
    if (preformatted) {
      if (value.length > 0) this.write(value);
      return;
    }
    const collapsed = value.replace(/[\t\n\f\r ]+/g, " ");
    if (collapsed.startsWith(" ")) this.space = true;
    const words = collapsed.trim();
    if (words.length === 0) return;
    this.write(words);
    if (collapsed.endsWith(" ")) this.space = true;
  }
  private write(value: string) {
    if (this.parts.length > 0) {
      if (this.breaks > 0) this.parts.push("\n".repeat(this.breaks));
      else if (this.space) this.parts.push(" ");
    }
    this.parts.push(value);
    this.breaks = 0;
    this.space = false;
  }
  done(): string {
    return this.parts
      .join("")
      .replace(/\u{A0}/gu, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trimEnd();
  }
}

// ---------- the pass ----------

interface Open {
  readonly name: string;
  readonly hidden: boolean;
  readonly preformatted: boolean;
  /** A link's target and where its text starts. */
  readonly link?: { readonly href: string; readonly mark: number };
}

/** A start tag's attributes from `at`, and the index past its `>`, or `undefined` if it's cut. */
const readAttributes = (
  html: string,
  at: number
): { readonly attributes: Map<string, string>; readonly end: number } | undefined => {
  const attributes = new Map<string, string>();
  let position = at;
  while (position < html.length) {
    SEPARATOR.lastIndex = position;
    if (SEPARATOR.test(html)) position = SEPARATOR.lastIndex;
    if (position >= html.length) return undefined;
    if (html[position] === ">") return { attributes, end: position + 1 };
    ATTRIBUTE.lastIndex = position;
    const match = ATTRIBUTE.exec(html);
    if (match === null) {
      position += 1;
      continue;
    }
    position = ATTRIBUTE.lastIndex;
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name))
      attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? "", true));
  }
  return undefined;
};

/** The HTML's visible text. Markup cut short, as by a partial fetch, ends at the last whole tag. */
export const htmlToText = (html: string): string => {
  const output = new Output();
  const stack: Open[] = [];
  const counts = new Map<string, number>();
  const top = () => stack[stack.length - 1];
  const hidden = () => top()?.hidden ?? false;
  const preformatted = () => top()?.preformatted ?? false;

  const pop = () => {
    const element = stack.pop()!;
    counts.set(element.name, counts.get(element.name)! - 1);
    if (element.hidden) return;
    if (PARAGRAPHS.has(element.name)) output.block(2);
    else if (LINES.has(element.name)) output.block(1);
    else if (element.name === "td" || element.name === "th") output.gap();
    else if (element.link !== undefined) {
      const text = output.since(element.link.mark).trim();
      const href = element.link.href;
      if (text !== href && text !== href.replace(/^mailto:/i, "")) output.text(` (${href})`, false);
    }
  };
  const close = (name: string) => {
    if (!counts.get(name)) return;
    while (top()!.name !== name) pop();
    pop();
  };
  /** The content of raw text element `name` from `at`, and the index past its end tag. */
  const rawContent = (name: string, at: number) => {
    const end = RAW_ENDS.get(name)!;
    end.lastIndex = at;
    const found = end.exec(html);
    if (found === null) return { content: html.slice(at), next: html.length };
    const gt = html.indexOf(">", found.index);
    return { content: html.slice(at, found.index), next: gt === -1 ? html.length : gt + 1 };
  };

  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > at && !hidden())
      output.text(decodeEntities(html.slice(at, textEnd)), preformatted());
    if (lt === -1) break;
    const next = html[lt + 1] ?? "";

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt + 2);
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    if (next === "/") {
      const end = html.indexOf(">", lt + 2);
      if (end === -1) break;
      at = end + 1;
      TAG_NAME.lastIndex = lt + 2;
      const name = TAG_NAME.exec(html)?.[0].toLowerCase();
      if (name === "br") {
        if (!hidden()) output.lineBreak();
      } else if (name !== undefined) close(name);
      continue;
    }
    TAG_NAME.lastIndex = lt + 1;
    const tag = TAG_NAME.exec(html);
    if (tag === null) {
      if (!hidden()) output.text("<", preformatted());
      at = lt + 1;
      continue;
    }
    const name = tag[0].toLowerCase();
    const read = readAttributes(html, TAG_NAME.lastIndex);
    if (read === undefined) break;
    at = read.end;
    if (DROPPED_RAW.has(name)) {
      at = rawContent(name, at).next;
      continue;
    }

    if (CLOSES_P.has(name) && top()?.name === "p") pop();
    // Links never nest: a browser closes the open one, and each link's text is then read once.
    if (name === "a") close("a");
    const siblings = SIBLINGS.get(name);
    if (siblings !== undefined) {
      while (top()?.name === "p") pop();
      const current = top();
      if (current !== undefined && siblings.includes(current.name)) pop();
    }
    const invisible = hidden() || hides(name, read.attributes);

    if (name === "plaintext") {
      if (!invisible) output.text(html.slice(at), true);
      break;
    }
    if (KEPT_RAW.has(name)) {
      const raw = rawContent(name, at);
      if (!invisible) {
        output.block(1);
        output.text(name === "textarea" ? decodeEntities(raw.content) : raw.content, true);
        output.block(1);
      }
      at = raw.next;
      continue;
    }

    if (!invisible) {
      if (PARAGRAPHS.has(name)) output.block(2);
      else if (LINES.has(name)) output.block(1);
      if (name === "br") output.lineBreak();
      if (name === "li") output.text("- ", false);
    }
    if (VOID.has(name)) continue;

    const href = read.attributes.get("href")?.trim();
    stack.push({
      name,
      hidden: invisible,
      preformatted: preformatted() || name === "pre",
      ...(name === "a" && href !== undefined && LINK.test(href) && href.length <= LINK_CHARACTERS
        ? { link: { href, mark: output.mark() } }
        : {})
    });
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return output.done();
};
