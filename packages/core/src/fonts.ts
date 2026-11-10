// @effect-diagnostics nodeBuiltinImport:off -- whether a release carries the display font is a fact of its files, read once on load, before any page draws.
import { existsSync } from "node:fs";
import display from "../fonts/display-font.json" with { type: "json" };

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

/**
 * Titles' typeface, Cabinet Grotesk Extrabold: the official `CabinetGrotesk-Extrabold.woff2` from
 * Fontshare's package (`Fonts/WEB/fonts/`), served byte for byte. It isn't in the repo. A private
 * bucket in Patchy's AWS account holds it, and a production deploy copies it beside the committed
 * fonts after checking it against the digest in `fonts/display-font.json`, which the deploy reads
 * too (docs/OPERATIONS.md › The display font). Anywhere else, CI and most local checkouts, the file
 * is absent and titles are Geist.
 */
export const displayFont = display;

export type Font = (typeof fonts)[number] | typeof displayFont;

/** Where the portal serves `font`, outside the viewer gate; "assets" is a reserved company handle. */
export const fontUrl = (font: Font): `/assets/fonts/${string}.woff2` =>
  `/assets/fonts/${font.file.replace(/\.woff2$/, "")}-${font.sha256.slice(0, 16)}.woff2`;

/** The font's file in `fonts/`, beside `src` and `dist` alike, and listed in the package's `files`. */
export const fontFile = (font: Font) => new URL(`../fonts/${font.file}`, import.meta.url);

/** Whether this release carries the display font. The portal refuses to start if its bytes are wrong. */
export const hasDisplayFont: boolean = existsSync(fontFile(displayFont));

/** The fonts the portal serves: the committed ones, and the display font where the release has it. */
export const servedFonts: ReadonlyArray<Font> = hasDisplayFont ? [...fonts, displayFont] : fonts;

const [geist, geistMono] = fonts;

/**
 * The faces a page declares, and the stack titles draw in, with or without the display font.
 * Without it there is no face to fetch, and titles are Geist. With it, titles are Cabinet Grotesk
 * over Geist. Geist and Cabinet Grotesk each have a fallback drawn from Arial (or Liberation Sans,
 * its metric twin) at their size and line metrics, so text barely moves when the face arrives:
 * Cabinet Grotesk's from Arial Bold, measured against its Extrabold. Where neither is installed,
 * the stack goes on to Geist's.
 */
export const fontStyles = (withDisplay: boolean) => ({
  faces: `
    @font-face { font-family: "Geist"; src: url("${fontUrl(geist)}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
    @font-face { font-family: "Geist Mono"; src: url("${fontUrl(geistMono)}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
    @font-face { font-family: "Geist Fallback"; src: local("Arial"), local("Liberation Sans"); ascent-override: 95.94%; descent-override: 28.16%; line-gap-override: 0%; size-adjust: 104.76%; }${
      withDisplay
        ? `
    @font-face { font-family: "${displayFont.family}"; src: url("${fontUrl(displayFont)}") format("woff2"); font-weight: 800; font-style: normal; font-display: swap; }
    @font-face { font-family: "${displayFont.family} Fallback"; src: local("Arial Bold"), local("Arial-BoldMT"), local("Liberation Sans Bold"), local("LiberationSans-Bold"); font-weight: 800; ascent-override: 93.23%; descent-override: 30%; line-gap-override: 9.64%; size-adjust: 93.32%; }`
        : ""
    }
`,
  displayStack: withDisplay
    ? `"${displayFont.family}", "${displayFont.family} Fallback", var(--font-ui)`
    : "var(--font-ui)"
});

/** This release's faces and title stack: the `fonts` chunk and `--font-display` in the tokens. */
export const { faces: fontFaces, displayStack } = fontStyles(hasDisplayFont);

/** Every page's text is Geist, so it is fetched with the document rather than after the CSS. */
export const fontPreload = `<link rel="preload" href="${fontUrl(geist)}" as="font" type="font/woff2" crossorigin>`;
