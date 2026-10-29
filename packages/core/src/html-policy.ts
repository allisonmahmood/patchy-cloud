import * as parse5 from "parse5";

/**
 * Bounds on the work markup can ask of the parser, and of every walk over what it builds. Steps of
 * the HTML parsing algorithm cost time in proportion to how deep the markup nests, how many
 * attributes an element carries and how many nodes error recovery moves or clones, so a page under
 * the read limit could otherwise hold the server for most of a minute. Each bound is far beyond
 * what a page needs; Chromium's parser stops nesting at the same depth.
 */
const MAX_DEPTH = 512;
const MAX_ATTRIBUTES = 256;
/** Counted in the siblings error recovery passes as it moves nodes; see `locate`. */
const MAX_REPAIR_WORK = 1 << 24;
/**
 * Counted in elements and their attributes as they are created, and in the characters of those
 * attributes. Both are far beyond what the markup read spells out, but error recovery reopens
 * formatting elements left open across blocks by cloning them, attributes and all, so a short page
 * could otherwise ask for hundreds of millions, and every check of an attribute would read each
 * clone's copy again.
 */
const MAX_CREATED = 1 << 20;
const MAX_CREATED_CHARACTERS = 1 << 24;

const TOO_DEEP = `HTML nests elements more than ${MAX_DEPTH} deep.`;
const TOO_MANY_ATTRIBUTES = `An element has more than ${MAX_ATTRIBUTES} attributes.`;
const TOO_MUCH_REPAIR =
  "HTML needs too much repair to check: close elements in the order they were opened, and keep table content inside cells.";

type HtmlNode = parse5.DefaultTreeAdapterMap["node"];

/** Thrown mid-parse when markup crosses one of the bounds; its message says which. */
export class ParseLimitExceeded extends Error {}

/**
 * Stops an element's attributes at the bound. The tokenizer checks each new attribute against
 * every earlier one on the same element, so an element costs the square of its attribute count.
 */
class BoundedTokenizer extends parse5.Tokenizer {
  protected override _createAttr(attrNameFirstCh: string): void {
    const token = this.currentToken;
    if (token && "attrs" in token && token.attrs.length >= MAX_ATTRIBUTES)
      throw new ParseLimitExceeded(TOO_MANY_ATTRIBUTES);
    super._createAttr(attrNameFirstCh);
  }
}

/**
 * parse5's parser, reading through the bounded tokenizer. It takes every argument parse5's own
 * does, because the fragment parser constructs it with a document and a context.
 */
class BoundedParser extends parse5.Parser<parse5.DefaultTreeAdapterMap> {
  constructor(...args: ConstructorParameters<typeof parse5.Parser<parse5.DefaultTreeAdapterMap>>) {
    super(...args);
    this.tokenizer = new BoundedTokenizer(this.options, this);
  }
}

/** A fragment, such as a look's logo, parsed under the bounds; past one it throws. */
export function parseBoundedFragment(
  html: string
): parse5.DefaultTreeAdapterMap["documentFragment"] {
  const parser = BoundedParser.getFragmentParser(null, { treeAdapter: boundedTreeAdapter() });
  parser.tokenizer.write(html, true);
  return parser.getFragment();
}

/**
 * parse5's default tree, built under the depth, attribute and repair bounds. Most tags scan the
 * stack of open elements, so the stack is what depth counts.
 */
function boundedTreeAdapter(): parse5.TreeAdapter<parse5.DefaultTreeAdapterMap> {
  const tree = parse5.defaultTreeAdapter;
  let depth = 0;
  let repairWork = 0;
  let created = 0;
  let createdCharacters = 0;

  /**
   * Finds a node among its siblings for error recovery to move it, searching from the end and
   * paying for every sibling after it, each of which the search passes and the move shifts.
   * Misplaced table content goes just before the open table, its parent's last child, so it costs
   * next to nothing; the children of an element closed out of order leave from the front, and pay
   * for the whole list each time.
   */
  const locate = (
    siblings: parse5.DefaultTreeAdapterMap["childNode"][],
    node: parse5.DefaultTreeAdapterMap["childNode"]
  ) => {
    const index = siblings.lastIndexOf(node);
    repairWork += siblings.length - index;
    if (repairWork > MAX_REPAIR_WORK) throw new ParseLimitExceeded(TOO_MUCH_REPAIR);
    return index;
  };

  return {
    ...tree,
    createElement(tagName, namespaceURI, attrs) {
      created += 1 + attrs.length;
      for (const { name, value } of attrs) createdCharacters += name.length + value.length;
      if (created > MAX_CREATED || createdCharacters > MAX_CREATED_CHARACTERS)
        throw new ParseLimitExceeded(TOO_MUCH_REPAIR);
      return tree.createElement(tagName, namespaceURI, attrs);
    },
    onItemPush() {
      depth += 1;
      if (depth > MAX_DEPTH) throw new ParseLimitExceeded(TOO_DEEP);
    },
    onItemPop() {
      depth -= 1;
    },
    // A repeated <html> or <body> tag adds its attributes to the first one.
    adoptAttributes(recipient, attrs) {
      tree.adoptAttributes(recipient, attrs);
      if (recipient.attrs.length > MAX_ATTRIBUTES)
        throw new ParseLimitExceeded(TOO_MANY_ATTRIBUTES);
    },
    // These three replace the default tree's, which search from the front.
    insertBefore(parent, node, reference) {
      parent.childNodes.splice(locate(parent.childNodes, reference), 0, node);
      node.parentNode = parent;
    },
    insertTextBefore(parent, text, reference) {
      const index = locate(parent.childNodes, reference);
      const previous = parent.childNodes[index - 1];
      if (previous && tree.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      const node = tree.createTextNode(text);
      parent.childNodes.splice(index, 0, node);
      node.parentNode = parent;
    },
    detachNode(node) {
      const parent = node.parentNode;
      if (!parent) return;
      parent.childNodes.splice(locate(parent.childNodes, node), 1);
      node.parentNode = null;
    }
  };
}

/** A page's title comes before its inline code, which runs to megabytes. */
const TITLE_SEARCH_CHARACTERS = 64 * 1024;

/**
 * A page's title, for publish and `patchy dev`. Only the start of the page is read, under the
 * parser's bounds. A title past that limit, cut by it, or in markup past a bound gives null, and
 * the patch keeps its name.
 */
export function documentTitle(html: string): string | null {
  const cut = html.length > TITLE_SEARCH_CHARACTERS;
  try {
    const document = BoundedParser.parse(html.slice(0, TITLE_SEARCH_CHARACTERS), {
      treeAdapter: boundedTreeAdapter(),
      sourceCodeLocationInfo: cut
    });
    return firstTitle(document, cut);
  } catch (error) {
    if (error instanceof ParseLimitExceeded) return null;
    throw error;
  }
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
