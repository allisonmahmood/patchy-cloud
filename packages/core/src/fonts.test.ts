import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { htmlPage, withoutAppAssets } from "./html.js";
import {
  displayFont,
  fontFaces,
  fontFile,
  fontPreload,
  fontStyles,
  fontUrl,
  fonts,
  hasDisplayFont
} from "./fonts.js";
import { chunks } from "./styles/index.js";
import { tokens } from "./styles/tokens.js";

describe("the app's fonts", () => {
  it("names each committed file's bytes in its URL", async () => {
    for (const font of fonts) {
      const bytes = await readFile(fontFile(font));
      expect(createHash("sha256").update(bytes).digest("hex"), font.file).toBe(font.sha256);
      // woff2's signature, so a renamed file of another format can't pass for one.
      expect(bytes.subarray(0, 4).toString("latin1"), font.file).toBe("wOF2");
      expect(fontUrl(font)).toMatch(/^\/assets\/fonts\/[A-Za-z-]+-[0-9a-f]{16}\.woff2$/);
      expect(fontFaces).toContain(`url("${fontUrl(font)}")`);
    }
  });

  it("ships the files with their licence, so the server image carries both", async () => {
    expect(packageJson.files).toContain("fonts");
    const licence = await readFile(new URL("../fonts/OFL.txt", import.meta.url), "utf8");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("preloads the text face, as fonts are always fetched", () => {
    expect(fontPreload).toBe(
      `<link rel="preload" href="${fontUrl(fonts[0])}" as="font" type="font/woff2" crossorigin>`
    );
  });

  it("leaves a page with nothing that asks for them, where a policy refuses them", () => {
    const page = htmlPage({ title: "Not found", body: "<main>Gone</main>" });
    const drawn = withoutAppAssets(page);
    expect(drawn).not.toMatch(/@font-face|rel="preload"|\/assets\/fonts\//);
    expect(drawn).toContain("<main>Gone</main>");
  });
});

describe("the display font", () => {
  it("with its file: a face at the URL naming its bytes, and titles in it over Geist", () => {
    const { faces, displayStack } = fontStyles(true);
    expect(fontUrl(displayFont)).toBe(
      "/assets/fonts/CabinetGrotesk-Extrabold-de0d7ba5c28ab4a8.woff2"
    );
    expect(faces).toContain(
      `@font-face { font-family: "Cabinet Grotesk"; src: url("${fontUrl(displayFont)}") format("woff2"); font-weight: 800; font-style: normal; font-display: swap; }`
    );
    // Its fallback is local, at Cabinet Grotesk's size, so it asks for nothing more.
    expect(faces).toMatch(/@font-face \{ font-family: "Cabinet Grotesk Fallback"; src: local\(/);
    expect(faces.match(/url\(/g)).toHaveLength(fonts.length + 1);
    expect(displayStack).toBe('"Cabinet Grotesk", "Cabinet Grotesk Fallback", var(--font-ui)');
  });

  it("without it: no face, so no request, and titles in Geist", () => {
    const { faces, displayStack } = fontStyles(false);
    expect(faces).not.toMatch(/Cabinet/);
    expect(faces).toContain(`url("${fontUrl(fonts[0])}")`);
    expect(displayStack).toBe("var(--font-ui)");
  });

  const releases: Array<string> = [];
  afterAll(() => Promise.all(releases.map((root) => rm(root, { recursive: true }))));

  /** This module laid out as a release lays out core, `src` beside `fonts`, holding `files`. */
  const release = async (files: Record<string, string>) => {
    const root = await mkdtemp(path.join(tmpdir(), "core-fonts-"));
    releases.push(root);
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "fonts"));
    await copyFile(new URL("./fonts.ts", import.meta.url), path.join(root, "src/fonts.ts"));
    await copyFile(
      new URL("../fonts/display-font.json", import.meta.url),
      path.join(root, "fonts/display-font.json")
    );
    for (const [name, text] of Object.entries(files))
      await writeFile(path.join(root, "fonts", name), text);
    const loaded: typeof import("./fonts.js") = await import(
      pathToFileURL(path.join(root, "src/fonts.ts")).href
    );
    return loaded;
  };

  it("is used where a release has its file beside the committed fonts, and only there", async () => {
    const without = await release({});
    expect(without.hasDisplayFont).toBe(false);
    expect(without.servedFonts.map((font) => font.file)).not.toContain(displayFont.file);
    expect(without.fontFaces).toBe(fontStyles(false).faces);
    expect(without.displayStack).toBe("var(--font-ui)");

    const carried = await release({ [displayFont.file]: "stands in for the font" });
    expect(carried.hasDisplayFont).toBe(true);
    expect(carried.servedFonts.map((font) => font.file)).toContain(displayFont.file);
    expect(carried.fontFaces).toBe(fontStyles(true).faces);
    expect(carried.displayStack).toBe(fontStyles(true).displayStack);
  });

  it("draws this release's stylesheet as its files have it", () => {
    expect(chunks.fonts).toBe(fontStyles(hasDisplayFont).faces);
    expect(tokens).toContain(`--font-display: ${fontStyles(hasDisplayFont).displayStack};`);
  });
});
