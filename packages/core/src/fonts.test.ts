import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { htmlPage, withoutAppAssets } from "./html.js";
import { fontFaces, fontFile, fontPreload, fontUrl, fonts } from "./fonts.js";

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
