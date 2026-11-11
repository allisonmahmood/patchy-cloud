import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fontPreload } from "./fonts.js";
import { appStyles, htmlPage } from "./html.js";
import { servedStyles } from "./served-styles.js";

describe("a running patch's shell styles", () => {
  // Every running patch's shell carries these bytes. A change here is a change to every patch's
  // shell, so it is made on purpose: update the digest in the same change, and say so.
  it("stay byte for byte as running patches have them", () => {
    expect(createHash("sha256").update(servedStyles).digest("hex")).toBe(
      "51bd05696bab814569e0590ed1c829c0c587896e025c863b3ec195b42e3bed2a"
    );
  });

  it("load no font of the app's: a patch's shell keeps its system fonts", () => {
    expect(servedStyles).not.toMatch(/@font-face|Geist|Cabinet|\/assets\/fonts\//);
  });
});

describe("a first-party page", () => {
  it("draws in Geist, fetched with the document", () => {
    const html = htmlPage({ title: "Sign in", body: "<main>Hello</main>" });
    expect(html).toContain(fontPreload);
    expect(html).toContain(appStyles);
    expect(appStyles).toMatch(/--font-ui: "Geist", "Geist Fallback"/);
    expect(appStyles).toMatch(/--font-mono: "Geist Mono"/);
    expect(appStyles).toContain('@font-face { font-family: "Geist";');
  });
});
