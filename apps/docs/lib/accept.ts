/**
 * Whether a request's `Accept` header picks a docs page's Markdown over its HTML, the page's two
 * representations. Each takes the quality of the most specific range that matches it: its own
 * type, then `text/*`, then the any-type wildcard. The higher quality wins. A tie goes to HTML,
 * the default, unless the request names `text/markdown` itself, which browsers never do. No
 * header, or one that accepts neither, gets HTML. `proxy.ts` decides with this.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = parse(accept);
  const html = match(ranges, "html");
  const markdown = match(ranges, "markdown");
  if (markdown.quality !== html.quality) return markdown.quality > html.quality;
  return markdown.quality > 0 && markdown.specificity === EXACT;
}

interface Range {
  readonly type: string;
  readonly subtype: string;
  readonly quality: number;
}

const EXACT = 2;

/** Each media range with its `q`, 1 when absent or unreadable; other parameters are ignored. */
function parse(accept: string): ReadonlyArray<Range> {
  return accept.split(",").flatMap((part) => {
    const [mediaRange = "", ...parameters] = part.split(";");
    const [type, subtype] = mediaRange.trim().toLowerCase().split("/");
    if (!type || !subtype) return [];
    const q = parameters.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
    const quality = q === undefined ? Number.NaN : Number.parseFloat(q.slice(2));
    return [
      { type, subtype, quality: Number.isNaN(quality) ? 1 : Math.min(Math.max(quality, 0), 1) }
    ];
  });
}

/** How closely a range names `text/<subtype>`: 2 exactly, 1 as `text/*`, 0 as any type, -1 not. */
function specificity(range: Range, subtype: string): number {
  if (range.type === "*" && range.subtype === "*") return 0;
  if (range.type !== "text") return -1;
  if (range.subtype === "*") return 1;
  return range.subtype === subtype ? EXACT : -1;
}

/** The quality `text/<subtype>` gets from its most specific matching range, 0 when none matches. */
function match(ranges: ReadonlyArray<Range>, subtype: "html" | "markdown") {
  let best = { specificity: -1, quality: 0 };
  for (const range of ranges) {
    const level = specificity(range, subtype);
    if (level > best.specificity) best = { specificity: level, quality: range.quality };
  }
  return best;
}
