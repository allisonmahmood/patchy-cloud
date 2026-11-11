import { describe, expect, it } from "vitest";
import { productLogos } from "./logos.js";
import { productMark } from "./index.js";

describe("a product mark", () => {
  it("draws a product Patchy knows as its own logo, inline on the same square", () => {
    const cursor = productMark({ logo: "cursor" });
    expect(cursor).toMatch(
      /^<span class="im im-logo" aria-hidden="true"><svg viewBox="0 0 466\.73 532\.09" aria-hidden="true" focusable="false"><path /
    );
    // In its own colour, not the page's ink.
    expect(cursor).toContain('fill="#26251e"');
    expect(productMark({ logo: "attio" }, { large: true })).toMatch(
      /^<span class="im im-logo im-lg" aria-hidden="true"><svg /
    );
  });

  it("draws a kind of product as an icon, and any other as its letters, escaped", () => {
    expect(productMark({ icon: "mail" })).toMatch(
      /^<span class="im" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"/
    );
    expect(productMark("Pg", { large: true })).toBe(
      '<span class="im im-lg" aria-hidden="true">Pg</span>'
    );
    expect(productMark("+", { dashed: true })).toBe(
      '<span class="im im-dashed" aria-hidden="true">+</span>'
    );
    expect(productMark("<b>")).toContain("&lt;b&gt;");
  });

  // A page can show one logo many times, so nothing in one may need an id.
  it.each(Object.entries(productLogos))("keeps %s's logo lean and free of ids", (_, logo) => {
    expect(logo.body).not.toMatch(
      /\s(id|style)=|<image|data:|<!--|<metadata|<style|<script|xlink/i
    );
    expect(logo.viewBox).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    expect(logo.body.length).toBeLessThan(4096);
  });
});
