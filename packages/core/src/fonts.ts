/**
 * The app's typefaces: Geist for text and Geist Mono for what is typed or copied. They are
 * Vercel's variable fonts exactly as released (the `geist` package, 1.9.2), under the SIL Open
 * Font License in `fonts/OFL.txt`. Only first-party pages use them; a running patch's shell keeps
 * its system fonts, and its policy admits no font of ours.
 *
 * Each file is served at a URL naming its bytes, so a browser keeps it for good and a release
 * with new bytes has a new URL. `sha256` is the file's digest, which a test checks.
 */
export const fonts = [
  {
    family: "Geist",
    file: "Geist-Variable.woff2",
    sha256: "3626eba547294501c8a4d662c7d9ea3b49734409a4c5a1ccf12fa86429b1687e"
  },
  {
    family: "Geist Mono",
    file: "GeistMono-Variable.woff2",
    sha256: "5d93ee62680bbec1abc5405c2658311f9396f6f9a821ef8551ec463887e600d4"
  }
] as const;

export type Font = (typeof fonts)[number];

/** Where the portal serves `font`, outside the viewer gate; "assets" is a reserved company handle. */
export const fontUrl = (font: Font): `/assets/fonts/${string}.woff2` =>
  `/assets/fonts/${font.file.replace(/\.woff2$/, "")}-${font.sha256.slice(0, 16)}.woff2`;

/** The committed file, beside `src` and `dist` alike, and listed in the package's `files`. */
export const fontFile = (font: Font) => new URL(`../fonts/${font.file}`, import.meta.url);

const [geist, geistMono] = fonts;

/**
 * The faces, and a fallback drawn from Arial (or Liberation Sans, its metric twin) at Geist's
 * size and line metrics, so text barely moves when Geist arrives.
 */
export const fontFaces = `
    @font-face { font-family: "Geist"; src: url("${fontUrl(geist)}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
    @font-face { font-family: "Geist Mono"; src: url("${fontUrl(geistMono)}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
    @font-face { font-family: "Geist Fallback"; src: local("Arial"), local("Liberation Sans"); ascent-override: 95.94%; descent-override: 28.16%; line-gap-override: 0%; size-adjust: 104.76%; }
`;

/** Every page's text is Geist, so it is fetched with the document rather than after the CSS. */
export const fontPreload = `<link rel="preload" href="${fontUrl(geist)}" as="font" type="font/woff2" crossorigin>`;

/**
 * A first-party document without the app's fonts, for one drawn under a policy that refuses
 * them, such as a refusal at a content URL inside the frame's sandbox. Its text falls back to
 * the system fonts the stack names after Geist.
 */
export const withoutAppFonts = (html: string) =>
  html.replace(fontPreload, "").replace(fontFaces, "");
