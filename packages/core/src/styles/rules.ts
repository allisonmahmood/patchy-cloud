/**
 * What the app's stylesheet may write outside the token block: the rule `styles.test.ts` holds
 * every chunk to, and `pnpm ui:report` prints. It reads emitted CSS by property, so a visual value
 * fails wherever it is written, and lets layout geometry through.
 *
 * - **Colour**: no colour literal anywhere (a hex, `rgb()`, `hsl()` and the rest, or a named
 *   colour). A colour is a token, or `color-mix()` of tokens and `currentColor`.
 * - **Type**: `font`, `font-size`, `font-weight`, `line-height` and `font-family` take tokens.
 * - **Radius**: a corner takes a token, or a value derived from one; a percentage is a shape.
 * - **Shadow**: a shadow takes a token. A ring with no offset (`inset 0 0 0 1px …`) is an edge.
 * - **Control height**: a control's height takes a token, or a value derived from one, so a coarse
 *   pointer raises it with the rest.
 *
 * Drawings keep their own size, corners and letter size, because each scales as one shape: marks,
 * keycaps, icons and pseudo-elements. Their colours and shadows are still tokens. Widths, gaps,
 * padding and the heights of rows and bars are geometry. `servedStyles`, the font faces' fallback
 * metrics and the token block itself are not chunks this rule reads.
 */

/** One declaration as the stylesheet emits it, under its rule's selector list. */
export interface Declaration {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
}

/** A value written outside the token block, and the role it plays. */
export interface Finding extends Declaration {
  readonly role: "colour" | "type" | "radius" | "shadow" | "control height";
}

/** Every declaration in `css`, through `@media`, `@supports` and `@container` blocks. */
export const declarations = (css: string): ReadonlyArray<Declaration> => {
  const found: Array<Declaration> = [];
  const walk = (text: string) => {
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf("{", at);
      if (open === -1) return;
      let depth = 1;
      let end = open + 1;
      for (; end < text.length && depth > 0; end++)
        depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0;
      const prelude = text.slice(at, open).trim();
      const body = text.slice(open + 1, end - 1);
      if (/^@(media|supports|container|layer)\b/.test(prelude)) walk(body);
      else if (!prelude.startsWith("@"))
        for (const part of body.split(";")) {
          const colon = part.indexOf(":");
          if (colon === -1) continue;
          found.push({
            selector: prelude.replace(/\s+/g, " "),
            property: part.slice(0, colon).trim().toLowerCase(),
            value: part.slice(colon + 1).trim()
          });
        }
      at = end;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return found;
};

/** The value without its `var()` references, nested ones included. */
const withoutTokens = (value: string) => {
  let rest = value;
  for (let before = ""; before !== rest;) {
    before = rest;
    rest = rest.replace(/var\([^()]*\)/g, " ");
  }
  return rest;
};

/** The value without its tokens and quoted strings: what was written by hand. */
const handWritten = (value: string) => withoutTokens(value.replace(/"[^"]*"|'[^']*'/g, " "));

/** A list's items at the top level, so a comma inside `color-mix()` doesn't split one. */
const topLevel = (value: string) => {
  const items = [""];
  let depth = 0;
  for (const char of value) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (char === "," && depth === 0) items.push("");
    else items[items.length - 1] += char;
  }
  return items.map((item) => item.trim());
};

// The CSS named colours, besides transparent and currentColor.
const named = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " "
  )
);

const colourLiteral = (rest: string) =>
  /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(rest) ||
  (rest.toLowerCase().match(/(?<![\w-])[a-z]+(?![\w-])/g) ?? []).some((word) => named.has(word));

/** A length other than zero, in any CSS unit, wherever it stands: `4px`, `.929em`, `calc(5vh)`. */
const length =
  /(?<![\w.#-])(?!0*\.?0+[a-z]+(?![\w-]))\d*\.?\d+(px|r?em|r?ex|r?ch|r?cap|r?ic|r?lh|[sld]?v(w|h|i|b|min|max)|cq(w|h|i|b|min|max)|cm|mm|q|in|pt|pc)(?![\w-])/i;

/** A value's parts at the top level, split on spaces and slashes, so a function stays whole. */
const parts = (value: string) => {
  const found = [""];
  let depth = 0;
  for (const char of value) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (depth === 0 && /[\s/]/.test(char)) found.push("");
    else found[found.length - 1] += char;
  }
  return found.filter((part) => part !== "");
};

/**
 * Whether any of a value's parts is a length written by hand. A token, or a function of one such
 * as `calc(var(--h-control) - 2px)`, is drawn from the block; a percentage is a shape.
 */
const rawLength = (value: string) =>
  parts(value).some((part) => !part.includes("var(") && length.test(part));

// Weights, sizes and system fonts named by keyword are type written by hand too.
const typeKeywords =
  /(?<![\w-])(bold|bolder|lighter|normal|larger|smaller|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|caption|icon|menu|message-box|small-caption|status-bar)(?![\w-])/;

/** The selector's last compound, where the declaration lands. */
const subject = (selector: string) =>
  selector
    .trim()
    .split(/\s*[\s>+~]\s*/)
    .at(-1) ?? "";

const drawing =
  /::?(before|after)\b|(^|[\s>+~])(svg|kbd)\b|\.(glyph|mono|page-mark|avatar|av|agent-mark|im|kbd|command-icon|step-marker)(-[\w-]+)?\b/;

/** A declaration on a mark, keycap, icon or pseudo-element: a drawing, which scales as one shape. */
const isDrawing = (selector: string) =>
  topLevel(selector).every((part) => drawing.test(` ${subject(part)}`));

const control =
  /(^|[\s>+~.])(button|input|select|textarea)\b|\.(btn|btn-sm|btn-md|btn-icon|field|field-group|chip|menu-item|app-place|seg|tabs|copy-line)(?![\w-])/;

/** A declaration on something pressed or typed into, rather than an icon inside it. */
const isControl = (selector: string) =>
  topLevel(selector).some((part) => control.test(part) && !drawing.test(` ${subject(part)}`));

/** Whether a declaration's shadows are tokens, or rings with no offset. */
const shadowFromTokens = (value: string) =>
  topLevel(value).every(
    (shadow) =>
      shadow === "none" ||
      handWritten(shadow).trim() === "" ||
      /^(inset\s+)?0\s+0\s+0\s+\d*\.?\d+px\s+(var\(|color-mix\()/.test(shadow)
  );

/** The role a declaration's hand-written value plays, if it plays one; `undefined` when it's geometry. */
export const role = (declaration: Declaration): Finding["role"] | undefined => {
  const { selector, property } = declaration;
  const value = declaration.value.replace(/\s*!\s*important\s*$/i, "");
  const rest = handWritten(value);
  if (colourLiteral(rest)) return "colour";
  if (/^(box|text)-shadow$/.test(property)) return shadowFromTokens(value) ? undefined : "shadow";
  if (isDrawing(selector)) return undefined;
  // A family's name is quoted, so it is read with its strings.
  if (property === "font-family")
    return /^(inherit|initial|unset|revert)?$/.test(withoutTokens(value).trim())
      ? undefined
      : "type";
  if (/^(font|font-size|font-weight|line-height)$/.test(property))
    return /\d/.test(rest) || typeKeywords.test(rest) ? "type" : undefined;
  if (/^border(-[a-z]+)*-radius$/.test(property)) return rawLength(value) ? "radius" : undefined;
  // 1px is a visually hidden input, under the row or card drawn for it.
  if (/^(min-)?(height|block-size)$/.test(property) && isControl(selector))
    return rawLength(value) && value !== "1px" ? "control height" : undefined;
  return undefined;
};

/** The declarations in `css` that write a visual value by hand. */
export const offTokens = (css: string): ReadonlyArray<Finding> =>
  declarations(css).flatMap((declaration) => {
    const found = role(declaration);
    return found === undefined ? [] : [{ ...declaration, role: found }];
  });
